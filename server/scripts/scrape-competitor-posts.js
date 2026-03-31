#!/usr/bin/env node
/**
 * scrape-competitor-posts.js — Scrape post metadata (likes, comments, caption, timestamp)
 * from each tracked competitor's Instagram profile.
 *
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/scrape-competitor-posts.js
 *
 * Output: COMPETITOR_POSTS_FILE — JSON array of post objects ready for the
 * /api/external/competitor-top-posts endpoint.
 *
 * Required env vars:
 *   CLIENT_ID               — client identifier
 *   SESSION_DIR             — Instagram browser session path
 *   COMPETITORS_FILE        — path to knowledge/competitors.json
 *   COMPETITOR_POSTS_FILE   — output path for competitor-posts.json
 *
 * Optional env vars:
 *   PROXY            — proxy URL
 *   POSTS_PER_ACCOUNT — posts to check per competitor (default: 12)
 *   MIN_COMMENTS      — only save posts with >= this many comments (default: 0, i.e. save all)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CLIENT_ID            = process.env.CLIENT_ID            || '';
const SESSION_DIR          = process.env.SESSION_DIR          || '';
const COMPETITORS_FILE     = process.env.COMPETITORS_FILE     || '';
const COMPETITOR_POSTS_FILE= process.env.COMPETITOR_POSTS_FILE|| '';
const PROXY                = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const POSTS_PER_ACCOUNT    = parseInt(process.env.POSTS_PER_ACCOUNT || '12', 10);
const MIN_COMMENTS_SAVE    = parseInt(process.env.MIN_COMMENTS || '0', 10);

if (!CLIENT_ID || !SESSION_DIR || !COMPETITORS_FILE || !COMPETITOR_POSTS_FILE) {
  console.error('[ci-scrape] ERROR: CLIENT_ID, SESSION_DIR, COMPETITORS_FILE, COMPETITOR_POSTS_FILE required');
  process.exit(1);
}

const delay    = ms => new Promise(r => setTimeout(r, ms));
const randDelay = () => delay(3000 + Math.random() * 4000);

function loadCompetitors() {
  try { return JSON.parse(fs.readFileSync(COMPETITORS_FILE, 'utf8')); } catch { return []; }
}

function loadExistingPosts() {
  try { return JSON.parse(fs.readFileSync(COMPETITOR_POSTS_FILE, 'utf8')); } catch { return []; }
}

function savePosts(posts) {
  fs.mkdirSync(path.dirname(COMPETITOR_POSTS_FILE), { recursive: true });
  fs.writeFileSync(COMPETITOR_POSTS_FILE, JSON.stringify(posts, null, 2));
}

async function dismissOverlays(page) {
  for (const sel of [
    'button:has-text("Not Now")', 'button:has-text("Not now")',
    'div[role="button"]:has-text("Not Now")',
    '[aria-label="Close"]',
    'div[role="button"]:has-text("Continue"):not(:has-text("Continue as"))',
    'button:has-text("Continue"):not(:has-text("Continue as"))',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) { await btn.click(); await delay(600); }
    } catch {}
  }
}

// Extract shortcodes from a competitor's profile page grid
async function getProfilePostShortcodes(page, handle) {
  const url = `https://www.instagram.com/${handle}/`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(3000);
    await dismissOverlays(page);

    // Check if profile exists
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (bodyText.includes("Sorry, this page isn't available") || bodyText.includes("Page Not Found")) {
      console.log(`[ci-scrape]   @${handle} — profile not found`);
      return [];
    }

    // Scroll a bit to load the grid
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await delay(1200);
    }

    // Extract post links from the grid
    const shortcodes = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
      const seen = new Set();
      return links
        .map(a => {
          const m = a.href.match(/\/p\/([A-Za-z0-9_-]+)/);
          return m ? m[1] : null;
        })
        .filter(sc => {
          if (!sc || seen.has(sc)) return false;
          seen.add(sc);
          return true;
        });
    }).catch(() => []);

    return shortcodes.slice(0, POSTS_PER_ACCOUNT);
  } catch (e) {
    console.log(`[ci-scrape]   @${handle} profile error: ${e.message}`);
    return [];
  }
}

// Extract engagement data from a single post page
async function scrapePostData(page, shortCode, handle, competitorName) {
  const postUrl = `https://www.instagram.com/p/${shortCode}/`;
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(2500);
    await dismissOverlays(page);

    const data = await page.evaluate((url) => {
      // Caption
      const captionEl = document.querySelector('h1, [data-testid="post-comment-root"] span, article div span');
      const caption = (captionEl?.innerText || '').trim().slice(0, 400);

      // Likes — Instagram often hides exact count but shows a number
      let likesCount = 0;
      const likeEls = Array.from(document.querySelectorAll('span, button, a'));
      for (const el of likeEls) {
        const txt = el.innerText || '';
        const m = txt.match(/^([\d,]+)\s*(likes?|like)/i);
        if (m) { likesCount = parseInt(m[1].replace(/,/g, ''), 10); break; }
      }
      // Fallback: look for aria-label with likes
      const likeBtn = document.querySelector('[aria-label*="like" i]');
      if (!likesCount && likeBtn) {
        const m2 = (likeBtn.getAttribute('aria-label') || '').match(/([\d,]+)/);
        if (m2) likesCount = parseInt(m2[1].replace(/,/g, ''), 10);
      }

      // Comments count — from section heading or button
      let commentsCount = 0;
      const allText = document.body?.innerText || '';
      const commentMatch = allText.match(/([\d,]+)\s*comments?/i);
      if (commentMatch) commentsCount = parseInt(commentMatch[1].replace(/,/g, ''), 10);

      // Timestamp
      const timeEl = document.querySelector('time[datetime]');
      const timestamp = timeEl?.getAttribute('datetime') || '';

      // Hashtags
      const hashtagEls = Array.from(document.querySelectorAll('a[href*="/explore/tags/"]'));
      const hashtags = [...new Set(hashtagEls.map(el => el.innerText.replace('#', '').trim()))].slice(0, 10);

      // Sponsored / Partnership label
      const bodyText = document.body?.innerText || '';
      const isSponsored = /paid partnership|sponsored|ad\b/i.test(bodyText);

      return { caption, likesCount, commentsCount, timestamp, hashtags, isSponsored };
    }, postUrl).catch(() => ({ caption: '', likesCount: 0, commentsCount: 0, timestamp: '', hashtags: [], isSponsored: false }));

    return {
      ownerUsername: handle,
      competitorName,
      shortCode,
      url: postUrl,
      caption:       data.caption,
      likesCount:    data.likesCount,
      commentsCount: data.commentsCount,
      timestamp:     data.timestamp || new Date().toISOString(),
      isSponsored:   data.isSponsored,
      hashtags:      data.hashtags,
      scrapedAt:     new Date().toISOString(),
    };
  } catch (e) {
    console.log(`[ci-scrape]   post ${shortCode} error: ${e.message}`);
    return null;
  }
}

(async () => {
  const competitors = loadCompetitors();
  const enabled = competitors.filter(c => c.instagram && c.hunt_priority !== 'disabled');

  if (!enabled.length) {
    console.log('[ci-scrape] No competitors with instagram handles found — add them via Intel tab');
    process.exit(0);
  }

  console.log(`[ci-scrape] Scraping posts from ${enabled.length} competitors`);

  // Launch browser
  const launchOpts = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
  };
  if (PROXY) {
    const u = new URL(PROXY.includes('://') ? PROXY : 'http://' + PROXY);
    launchOpts.proxy = { server: u.protocol + '//' + u.host };
    if (u.username) launchOpts.proxy.username = decodeURIComponent(u.username);
    if (u.password) launchOpts.proxy.password = decodeURIComponent(u.password);
  }

  // Clear stale SingletonLock before launch (per CLAUDE.md: delete lock and retry once)
  const lockFile = path.join(SESSION_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    try { fs.unlinkSync(lockFile); console.log('[ci-scrape] Removed stale SingletonLock'); } catch {}
  }

  let context, page;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, launchOpts);
    page = context.pages()[0] || await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' });
  } catch (e) {
    console.error('[ci-scrape] Browser launch failed:', e.message);
    process.exit(1);
  }

  // Verify Instagram session
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);
    if (page.url().includes('/accounts/login') || page.url().includes('/login')) {
      console.error('[ci-scrape] STOP: Instagram session not logged in — re-login via admin VNC');
      await context.close();
      process.exit(1);
    }
    console.log('[ci-scrape] ✅ Instagram session active');
  } catch (e) {
    console.error('[ci-scrape] ERROR loading Instagram:', e.message);
    await context.close();
    process.exit(1);
  }

  // Load existing posts — keep posts newer than 30 days, replace older ones
  const existing = loadExistingPosts();
  const cutoff = Date.now() - 30 * 86400000;
  const retained = existing.filter(p => new Date(p.scrapedAt || 0).getTime() > cutoff);
  const existingKeys = new Set(retained.map(p => p.shortCode));

  const newPosts = [];
  let totalScraped = 0;

  for (const comp of enabled) {
    const handle = (comp.instagram || '').replace(/^@/, '');
    if (!handle) continue;

    console.log(`\n[ci-scrape] @${handle} (${comp.name}) — priority: ${comp.hunt_priority || 'normal'}`);

    try {
      const shortcodes = await getProfilePostShortcodes(page, handle);
      console.log(`[ci-scrape]   Found ${shortcodes.length} post shortcodes`);

      // Only scrape posts we haven't seen recently
      const toScrape = shortcodes.filter(sc => !existingKeys.has(sc));
      console.log(`[ci-scrape]   ${toScrape.length} new posts to scrape (${shortcodes.length - toScrape.length} already cached)`);

      for (const sc of toScrape) {
        const post = await scrapePostData(page, sc, handle, comp.name);
        if (!post) continue;

        if (post.commentsCount >= MIN_COMMENTS_SAVE || post.likesCount > 0) {
          newPosts.push(post);
          existingKeys.add(sc);
          totalScraped++;
          console.log(`[ci-scrape]   ✓ ${sc} — ${post.likesCount} likes, ${post.commentsCount} comments${post.isSponsored ? ' [AD]' : ''}`);
        }

        await delay(2000 + Math.random() * 2000);
      }
    } catch (e) {
      console.error(`[ci-scrape]   ERROR for @${handle}:`, e.message);
      try { await page.evaluate('window.stop()'); } catch {}
      await delay(3000);
    }

    await randDelay();
  }

  await context.close();

  // Merge retained + new, sort by commentsCount desc
  const allPosts = [...retained, ...newPosts]
    .sort((a, b) => (b.commentsCount - a.commentsCount) || (b.likesCount - a.likesCount));

  savePosts(allPosts);

  console.log(`\n[ci-scrape] ═══ SUMMARY ═══`);
  console.log(`[ci-scrape] New posts scraped:  ${totalScraped}`);
  console.log(`[ci-scrape] Retained from cache: ${retained.length}`);
  console.log(`[ci-scrape] Total in store:      ${allPosts.length}`);
  console.log(`[ci-scrape] Output:              ${COMPETITOR_POSTS_FILE}`);
  console.log(`[ci-scrape] ════════════════════`);
})();
