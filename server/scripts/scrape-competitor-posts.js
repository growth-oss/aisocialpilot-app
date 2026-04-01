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
 *   META_ADS_COUNTRY  — country code for Meta Ads Library filter (default: AE)
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
const META_ADS_COUNTRY     = process.env.META_ADS_COUNTRY || 'AE';

if (!CLIENT_ID || !SESSION_DIR || !COMPETITORS_FILE || !COMPETITOR_POSTS_FILE) {
  console.error('[ci-scrape] ERROR: CLIENT_ID, SESSION_DIR, COMPETITORS_FILE, COMPETITOR_POSTS_FILE required');
  process.exit(1);
}

const delay     = ms => new Promise(r => setTimeout(r, ms));
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

/**
 * Intercept Instagram's internal XHR responses while loading the profile page.
 * Instagram sends `web_profile_info?username=X` or `/api/v1/feed/user/{id}/`
 * responses that contain accurate like_count, comment_count, etc. for all posts.
 * Returns array of post objects already shaped for our schema.
 */
async function getProfilePostsViaIntercept(page, handle) {
  const posts = [];
  let resolved = false;

  const responseHandler = async (response) => {
    if (resolved) return;
    const url = response.url();
    // Match profile info or feed API endpoints
    const isProfileInfo = url.includes('web_profile_info') && url.includes(handle.toLowerCase());
    const isFeedApi = url.includes('/api/v1/feed/user/');
    if (!isProfileInfo && !isFeedApi) return;

    try {
      const body = await response.text().catch(() => null);
      if (!body) return;

      let data;
      try { data = JSON.parse(body); } catch { return; }

      // web_profile_info response shape
      if (isProfileInfo) {
        const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges;
        if (!Array.isArray(edges) || edges.length === 0) return;
        for (const edge of edges.slice(0, POSTS_PER_ACCOUNT)) {
          const node = edge.node || {};
          posts.push(shapeProfileInfoNode(node, handle));
        }
        resolved = true;
        return;
      }

      // /api/v1/feed/user/ response shape
      if (isFeedApi) {
        const items = data?.items;
        if (!Array.isArray(items) || items.length === 0) return;
        for (const item of items.slice(0, POSTS_PER_ACCOUNT)) {
          posts.push(shapeFeedItem(item, handle));
        }
        resolved = true;
      }
    } catch (e) {
      // silently skip malformed responses
    }
  };

  page.on('response', responseHandler);

  try {
    const url = `https://www.instagram.com/${handle}/`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000);
    await dismissOverlays(page);

    // Check for profile not found
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (bodyText.includes("Sorry, this page isn't available") || bodyText.includes("Page Not Found")) {
      console.log(`[ci-scrape]   @${handle} — profile not found`);
      page.off('response', responseHandler);
      return [];
    }

    // Scroll to trigger more XHR requests if needed
    for (let i = 0; i < 4 && !resolved; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await delay(1500);
    }

    // Wait a bit more for any in-flight XHR to complete
    if (!resolved) {
      await delay(3000);
    }
  } catch (e) {
    console.log(`[ci-scrape]   @${handle} profile intercept error: ${e.message}`);
  }

  page.off('response', responseHandler);

  if (posts.length > 0) {
    console.log(`[ci-scrape]   @${handle} — got ${posts.length} posts via API intercept ✅`);
  } else {
    console.log(`[ci-scrape]   @${handle} — no XHR intercept hit, will fall back to DOM`);
  }

  return posts;
}

/**
 * Shape a node from web_profile_info edges into our post schema.
 */
function shapeProfileInfoNode(node, handle) {
  const shortCode = node.shortcode || '';
  const caption   = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  const hashtags  = (caption.match(/#[\w\u0600-\u06FF]+/g) || []).map(h => h.replace('#', '')).slice(0, 10);
  const timestamp = node.taken_at_timestamp
    ? new Date(node.taken_at_timestamp * 1000).toISOString()
    : '';
  return {
    ownerUsername:  handle,
    competitorName: '', // filled in by caller
    shortCode,
    url:           `https://www.instagram.com/p/${shortCode}/`,
    caption:        caption.slice(0, 400),
    likesCount:     node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? 0,
    commentsCount:  node.edge_media_to_comment?.count ?? 0,
    timestamp:      timestamp || new Date().toISOString(),
    isSponsored:    false, // not available in this endpoint
    is_meta_ad:     false,
    hashtags,
    scrapedAt:      new Date().toISOString(),
  };
}

/**
 * Shape a feed item from /api/v1/feed/user/ into our post schema.
 */
function shapeFeedItem(item, handle) {
  const shortCode = item.code || item.shortcode || '';
  const caption   = item.caption?.text || '';
  const hashtags  = (caption.match(/#[\w\u0600-\u06FF]+/g) || []).map(h => h.replace('#', '')).slice(0, 10);
  const timestamp = item.taken_at
    ? new Date(item.taken_at * 1000).toISOString()
    : '';
  return {
    ownerUsername:  handle,
    competitorName: '', // filled in by caller
    shortCode,
    url:           `https://www.instagram.com/p/${shortCode}/`,
    caption:        caption.slice(0, 400),
    likesCount:     item.like_count ?? 0,
    commentsCount:  item.comment_count ?? 0,
    timestamp:      timestamp || new Date().toISOString(),
    isSponsored:    item.is_paid_partnership ?? false,
    is_meta_ad:     false,
    hashtags,
    scrapedAt:      new Date().toISOString(),
  };
}

/**
 * Fall back to DOM scraping if XHR intercept didn't fire.
 * Visits individual post pages — slower and returns 0 counts on most accounts
 * but at least captures shortcodes and captions.
 */
async function getPostsViaDom(page, handle) {
  const posts = [];
  try {
    // Extract shortcodes from grid
    const shortcodes = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
      const seen  = new Set();
      return links
        .map(a => { const m = a.href.match(/\/p\/([A-Za-z0-9_-]+)/); return m ? m[1] : null; })
        .filter(sc => { if (!sc || seen.has(sc)) return false; seen.add(sc); return true; });
    }).catch(() => []);

    console.log(`[ci-scrape]   @${handle} DOM fallback — ${shortcodes.length} shortcodes from grid`);

    for (const sc of shortcodes.slice(0, POSTS_PER_ACCOUNT)) {
      posts.push({
        ownerUsername:  handle,
        competitorName: '',
        shortCode:      sc,
        url:           `https://www.instagram.com/p/${sc}/`,
        caption:        '',
        likesCount:     0,
        commentsCount:  0,
        timestamp:      new Date().toISOString(),
        isSponsored:    false,
        is_meta_ad:     false,
        hashtags:       [],
        scrapedAt:      new Date().toISOString(),
      });
    }
  } catch (e) {
    console.log(`[ci-scrape]   @${handle} DOM fallback error: ${e.message}`);
  }
  return posts;
}

/**
 * Scrape Meta Ads Library for a competitor's active Instagram ads.
 * Opens a separate page in the same browser context, navigates to the Meta Ads Library,
 * intercepts the internal search_ads async API, and extracts Instagram post shortcodes.
 * Returns a Set of shortcodes that are currently active Meta ads.
 */
async function scrapeMetaAds(context, competitorName, handle) {
  const adShortcodes = new Set();
  const page = await context.newPage();
  let resolved = false;

  const responseHandler = async (response) => {
    if (resolved) return;
    const url = response.url();
    if (!url.includes('search_ads') && !url.includes('ads/library/async')) return;

    try {
      let body = await response.text().catch(() => null);
      if (!body) return;
      // Strip for(;;); prefix that Facebook adds to prevent JSON hijacking
      body = body.replace(/^for\s*\(\s*;;\s*\)\s*;/, '').trim();
      let data;
      try { data = JSON.parse(body); } catch { return; }

      // The payload structure varies — walk it to find Instagram post URLs
      const jsonStr = JSON.stringify(data);
      const shortcodeMatches = jsonStr.match(/instagram\.com\/p\/([A-Za-z0-9_-]+)/g) || [];
      for (const m of shortcodeMatches) {
        const sc = m.replace(/.*\/p\//, '');
        if (sc) adShortcodes.add(sc);
      }
      // Also look for reel URLs
      const reelMatches = jsonStr.match(/instagram\.com\/reel\/([A-Za-z0-9_-]+)/g) || [];
      for (const m of reelMatches) {
        const sc = m.replace(/.*\/reel\//, '');
        if (sc) adShortcodes.add(sc);
      }

      if (adShortcodes.size > 0) resolved = true;
    } catch {}
  };

  page.on('response', responseHandler);

  try {
    // Search by competitor handle first, then by name as fallback
    const queries = [handle, competitorName].filter(Boolean);
    for (const q of queries) {
      if (adShortcodes.size > 0) break;
      const adsUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${META_ADS_COUNTRY}&q=${encodeURIComponent(q)}&search_type=keyword_unordered`;
      console.log(`[ci-scrape]   Meta Ads search: "${q}" (${META_ADS_COUNTRY})`);
      try {
        await page.goto(adsUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(4000);
        // Scroll to trigger more results
        for (let i = 0; i < 3 && !resolved; i++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await delay(2000);
        }
      } catch (e) {
        console.log(`[ci-scrape]   Meta Ads page error for "${q}": ${e.message}`);
      }
    }
  } finally {
    page.off('response', responseHandler);
    try { await page.close(); } catch {}
  }

  if (adShortcodes.size > 0) {
    console.log(`[ci-scrape]   Meta Ads: found ${adShortcodes.size} active ad post(s) for @${handle} ✅`);
  } else {
    console.log(`[ci-scrape]   Meta Ads: no active ads found for @${handle}`);
  }

  return adShortcodes;
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

  // Clear stale Chrome singleton files before launch (use lstatSync — works for dangling symlinks)
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const fp = path.join(SESSION_DIR, f);
    try { fs.lstatSync(fp); fs.unlinkSync(fp); console.log(`[ci-scrape] Removed stale ${f}`); } catch {}
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
  const cutoff   = Date.now() - 30 * 86400000;
  const retained = existing.filter(p => new Date(p.scrapedAt || 0).getTime() > cutoff);
  const existingKeys = new Set(retained.map(p => p.shortCode));

  const newPosts = [];
  let totalScraped = 0;
  let totalMetaAds = 0;

  for (const comp of enabled) {
    const handle = (comp.instagram || '').replace(/^@/, '');
    if (!handle) continue;

    console.log(`\n[ci-scrape] @${handle} (${comp.name}) — priority: ${comp.hunt_priority || 'normal'}`);

    try {
      // ── Step 1: Get posts via API intercept ──────────────────────────────
      let profilePosts = await getProfilePostsViaIntercept(page, handle);

      // Fall back to DOM if intercept didn't fire
      if (profilePosts.length === 0) {
        profilePosts = await getPostsViaDom(page, handle);
      }

      // Attach competitor name
      profilePosts.forEach(p => { p.competitorName = comp.name; });

      // ── Step 2: Scrape Meta Ads Library for this competitor ──────────────
      const adShortcodes = await scrapeMetaAds(context, comp.name, handle);
      totalMetaAds += adShortcodes.size;

      // Mark profile posts that are also running as ads
      profilePosts.forEach(p => {
        if (adShortcodes.has(p.shortCode)) {
          p.is_meta_ad = true;
          adShortcodes.delete(p.shortCode); // remove so we don't double-add
        }
      });

      // Any ad shortcodes NOT already in the profile list — create stub entries
      // These might be older posts not shown in the grid
      for (const sc of adShortcodes) {
        profilePosts.push({
          ownerUsername:  handle,
          competitorName: comp.name,
          shortCode:      sc,
          url:           `https://www.instagram.com/p/${sc}/`,
          caption:        '',
          likesCount:     0,
          commentsCount:  0,
          timestamp:      new Date().toISOString(),
          isSponsored:    true,
          is_meta_ad:     true,
          hashtags:       [],
          scrapedAt:      new Date().toISOString(),
        });
      }

      // ── Step 3: Filter & save new posts ─────────────────────────────────
      const toSave = profilePosts.filter(p => !existingKeys.has(p.shortCode));
      console.log(`[ci-scrape]   ${toSave.length} new posts to save (${profilePosts.length - toSave.length} already cached)`);

      for (const post of toSave) {
        if (post.commentsCount >= MIN_COMMENTS_SAVE || post.likesCount > 0 || post.is_meta_ad) {
          newPosts.push(post);
          existingKeys.add(post.shortCode);
          totalScraped++;
          const adTag = post.is_meta_ad ? ' [META AD]' : '';
          console.log(`[ci-scrape]   ✓ ${post.shortCode} — ${post.likesCount} likes, ${post.commentsCount} comments${post.isSponsored ? ' [PAID]' : ''}${adTag}`);
        }
      }
    } catch (e) {
      console.error(`[ci-scrape]   ERROR for @${handle}:`, e.message);
      try { await page.evaluate('window.stop()'); } catch {}
      await delay(3000);
    }

    await randDelay();
  }

  await context.close();

  // Merge retained + new, sort: Meta Ads first, then commentsCount desc, then likesCount desc
  const allPosts = [...retained, ...newPosts].sort((a, b) => {
    if (a.is_meta_ad && !b.is_meta_ad) return -1;
    if (!a.is_meta_ad && b.is_meta_ad) return 1;
    return (b.commentsCount - a.commentsCount) || (b.likesCount - a.likesCount);
  });

  savePosts(allPosts);

  console.log(`\n[ci-scrape] ═══ SUMMARY ═══`);
  console.log(`[ci-scrape] New posts scraped:  ${totalScraped}`);
  console.log(`[ci-scrape] Meta Ads found:     ${totalMetaAds}`);
  console.log(`[ci-scrape] Retained from cache: ${retained.length}`);
  console.log(`[ci-scrape] Total in store:      ${allPosts.length}`);
  console.log(`[ci-scrape] Output:              ${COMPETITOR_POSTS_FILE}`);
  console.log(`[ci-scrape] ════════════════════`);
})();
