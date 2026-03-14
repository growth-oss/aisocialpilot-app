#!/usr/bin/env node
/**
 * scrape-youtube.js — Static YouTube scraping script for lead discovery.
 *
 * NEVER write this script from a Claude run — it is version-controlled and
 * injected with run-specific data via environment variables by the server.
 * See server/scripts/README.md for the full platform-scripts pattern.
 *
 * Required env vars:
 *   GOOGLE_SESSION_DIR   — persistent browser session path for Google/YouTube
 *   LEADS_FILE           — absolute path to leads.json
 *   SOURCES              — JSON array of source objects: [{type, handle_or_url, why}]
 *   CLIENT_ID            — client identifier
 *
 * Optional env vars:
 *   MAX_VIDEOS_PER_SOURCE  — max videos to scrape per source (default: 10)
 *   MAX_COMMENTERS_PER_VIDEO — max commenters per video (default: 30)
 *   MAX_LEADS_PER_SOURCE   — stop source after this many leads (default: 100)
 *   SCREENSHOTS_DIR        — where to save screenshots (default: /tmp)
 *   OUTREACH_LOG           — absolute path to outreach-log.ndjson
 *   SCORE_VIDEO_COMMENTER  — base score for keyword search commenters (default: 25)
 *   SCORE_CHANNEL_COMMENTER — base score for channel commenters (default: 30)
 *   SCORE_PURCHASE_SIGNAL  — bonus for purchase intent (default: 15)
 *   SCORE_GEO_BONUS        — bonus for UAE/geo mentions (default: 15)
 *
 * NOTE: YouTube scraping does NOT use a proxy — the social media proxy blocks
 * Google/YouTube domains. This script launches a plain browser with the Google
 * session dir for cookies only.
 *
 * YouTube leads are DISCOVERY ONLY — they enter the pipeline at stage 0.
 * They advance only via cross-platform match on Instagram or external contact.
 */

'use strict';

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');

// ── Read env vars ─────────────────────────────────────────────────────────────
const GOOGLE_SESSION_DIR      = process.env.GOOGLE_SESSION_DIR;
const LEADS_FILE              = process.env.LEADS_FILE;
const SOURCES                 = JSON.parse(process.env.SOURCES || '[]');
const CLIENT_ID               = process.env.CLIENT_ID || '';
const MAX_VIDEOS_PER_SOURCE   = parseInt(process.env.MAX_VIDEOS_PER_SOURCE || '10', 10);
const MAX_COMMENTERS_PER_VIDEO = parseInt(process.env.MAX_COMMENTERS_PER_VIDEO || '30', 10);
const MAX_LEADS_PER_SOURCE    = parseInt(process.env.MAX_LEADS_PER_SOURCE || '100', 10);
const SCREENSHOTS_DIR         = process.env.SCREENSHOTS_DIR || '/tmp';
const OUTREACH_LOG            = process.env.OUTREACH_LOG || '';
const SCORE_VIDEO_COMMENTER   = parseInt(process.env.SCORE_VIDEO_COMMENTER || '25', 10);
const SCORE_CHANNEL_COMMENTER = parseInt(process.env.SCORE_CHANNEL_COMMENTER || '30', 10);
const SCORE_PURCHASE_SIGNAL   = parseInt(process.env.SCORE_PURCHASE_SIGNAL || '15', 10);
const SCORE_GEO_BONUS         = parseInt(process.env.SCORE_GEO_BONUS || '15', 10);

if (!GOOGLE_SESSION_DIR || !LEADS_FILE || !SOURCES.length) {
  console.error('[fatal] Missing required env vars: GOOGLE_SESSION_DIR, LEADS_FILE, SOURCES');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag, ...args) {
  console.log(`[${tag}]`, ...args);
}

function rnd(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Purchase intent keywords — English + Arabic */
const PURCHASE_SIGNALS = [
  'where to buy', 'where can i buy', 'price', 'how much', 'link', 'recommend',
  'worth it', 'ordered', 'just bought', 'want to buy', 'looking for', 'need this',
  'shipping', 'delivery', 'discount', 'coupon', 'store', 'shop',
  'وين أشتري', 'كم سعر', 'السعر', 'رابط', 'أبي أشتري', 'طلبت', 'فين', 'محل',
];

/** Geo keywords for UAE targeting */
const GEO_KEYWORDS = [
  'uae', 'dubai', 'abu dhabi', 'sharjah', 'ajman', 'ras al khaimah', 'fujairah',
  'الإمارات', 'دبي', 'أبوظبي', 'الشارقة', 'عجمان',
];

function checkPurchaseSignal(text) {
  const lower = text.toLowerCase();
  for (const signal of PURCHASE_SIGNALS) {
    if (lower.includes(signal)) return signal;
  }
  return null;
}

function checkGeoMention(text) {
  const lower = text.toLowerCase();
  for (const geo of GEO_KEYWORDS) {
    if (lower.includes(geo)) return geo;
  }
  return null;
}

function loadLeads() {
  try {
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function appendOutreachLog(entry) {
  if (!OUTREACH_LOG) return;
  fs.appendFileSync(OUTREACH_LOG, JSON.stringify(entry) + '\n');
}

/** Extract a clean handle from a YouTube channel URL */
function extractHandle(channelUrl) {
  if (!channelUrl) return '';
  const match = channelUrl.match(/@([^\/\s]+)/);
  if (match) return match[1];
  // /channel/UCxxxxxx → use last segment
  const parts = channelUrl.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || '';
}

// ── Lock file cleanup ─────────────────────────────────────────────────────────
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(GOOGLE_SESSION_DIR, f)); log('session', `Removed stale ${f}`); }
  catch (e) { if (e.code !== 'ENOENT') log('session', `Note: could not remove ${f}: ${e.code}`); }
}

// Clear crash recovery state
const prefsPath = path.join(GOOGLE_SESSION_DIR, 'Default', 'Preferences');
try {
  if (fs.existsSync(prefsPath)) {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    if (prefs.profile) prefs.profile.exit_type = 'Normal';
    if (prefs.profile) prefs.profile.exited_cleanly = true;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    log('session', 'Cleared crash recovery state');
  }
} catch (e) { log('session', `Note: could not clear crash state: ${e.message}`); }

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  // NO PROXY — YouTube/Google is blocked by the social media proxy
  const context = await chromium.launchPersistentContext(GOOGLE_SESSION_DIR, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--hide-crash-restore-bubble',
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  let totalNewLeads = 0;

  try {
    // ── Verify YouTube access ───────────────────────────────────────────────
    log('auth', 'Navigating to YouTube…');
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie/consent banners
    try {
      const acceptBtn = page.locator('button:has-text("Accept all"), button:has-text("Accept"), tp-yt-paper-button:has-text("Accept")').first();
      if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await acceptBtn.click();
        await page.waitForTimeout(2000);
        log('auth', 'Dismissed consent banner');
      }
    } catch {}

    const isYouTube = await page.evaluate(() => document.title.includes('YouTube'));
    if (!isYouTube) {
      log('auth', 'WARNING: Page does not appear to be YouTube. Continuing anyway…');
    }
    log('auth', 'YouTube loaded OK');

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `yt-start-${Date.now()}.png`) });

    // ── Process each source ─────────────────────────────────────────────────
    for (let si = 0; si < SOURCES.length; si++) {
      const source = SOURCES[si];
      const sourceType = source.type; // 'keyword' or 'account'
      const query = source.handle_or_url;
      log('source', `[${si + 1}/${SOURCES.length}] Processing ${sourceType}: "${query}"`);

      let videoLinks = [];

      if (sourceType === 'keyword') {
        // ── Keyword search → video results ────────────────────────────────
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Wait for video results
        try {
          await page.waitForSelector('ytd-video-renderer', { timeout: 15000 });
        } catch {
          log('source', `  No video results found for "${query}" — skipping`);
          continue;
        }

        // Scroll down to load more results
        for (let s = 0; s < 3; s++) {
          await page.keyboard.press('End');
          await page.waitForTimeout(2000);
        }

        videoLinks = await page.$$eval(
          'ytd-video-renderer a#video-title',
          (els, max) => els.slice(0, max).map(a => ({
            url: a.href,
            title: a.textContent?.trim() || '',
          })),
          MAX_VIDEOS_PER_SOURCE
        );
        log('source', `  Found ${videoLinks.length} videos from search`);

      } else if (sourceType === 'account') {
        // ── Channel → videos tab ──────────────────────────────────────────
        let channelUrl = query;
        if (!channelUrl.startsWith('http')) {
          channelUrl = `https://www.youtube.com/${channelUrl.startsWith('@') ? channelUrl : '@' + channelUrl}`;
        }
        if (!channelUrl.includes('/videos')) {
          channelUrl = channelUrl.replace(/\/$/, '') + '/videos';
        }

        await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Wait for video grid
        try {
          await page.waitForSelector('ytd-rich-item-renderer, ytd-grid-video-renderer', { timeout: 15000 });
        } catch {
          log('source', `  No videos found on channel "${query}" — skipping`);
          continue;
        }

        videoLinks = await page.$$eval(
          'ytd-rich-item-renderer a#video-title-link, ytd-grid-video-renderer a#video-title',
          (els, max) => els.slice(0, max).map(a => ({
            url: a.href,
            title: a.textContent?.trim() || '',
          })),
          MAX_VIDEOS_PER_SOURCE
        );
        log('source', `  Found ${videoLinks.length} videos from channel`);
      } else {
        log('source', `  Unknown source type "${sourceType}" — skipping`);
        continue;
      }

      if (!videoLinks.length) {
        log('source', `  No videos to scrape — moving to next source`);
        continue;
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `yt-source-${si}-${Date.now()}.png`) });

      // ── Scrape commenters from each video ───────────────────────────────
      let sourceLeadCount = 0;
      const leads = loadLeads();
      const existingUsernames = new Set(leads.map(l => l.username?.toLowerCase()));
      const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
      let idCounter = nextId;

      for (let vi = 0; vi < videoLinks.length && sourceLeadCount < MAX_LEADS_PER_SOURCE; vi++) {
        const video = videoLinks[vi];
        log('video', `  [${vi + 1}/${videoLinks.length}] "${video.title.substring(0, 60)}…"`);

        try {
          await page.goto(video.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3000);

          // Scroll down to load comments
          for (let s = 0; s < 5; s++) {
            await page.evaluate(() => window.scrollBy(0, 800));
            await page.waitForTimeout(2000);
          }

          // Wait for comments to appear
          try {
            await page.waitForSelector('ytd-comment-thread-renderer', { timeout: 15000 });
          } catch {
            log('video', `    No comments loaded — skipping`);
            continue;
          }

          // Scroll a bit more to load additional comments
          for (let s = 0; s < 2; s++) {
            await page.evaluate(() => window.scrollBy(0, 600));
            await page.waitForTimeout(1500);
          }

          // Extract commenters
          const commenters = await page.$$eval(
            'ytd-comment-thread-renderer',
            (els, max) => els.slice(0, max).map(el => ({
              displayName: el.querySelector('#author-text span')?.textContent?.trim()
                || el.querySelector('#author-text')?.textContent?.trim() || '',
              channelUrl: el.querySelector('#author-text')?.href
                || el.querySelector('a#author-text')?.href || '',
              commentText: el.querySelector('#content-text')?.textContent?.trim() || '',
            })),
            MAX_COMMENTERS_PER_VIDEO
          );

          log('video', `    Extracted ${commenters.length} commenters`);

          // Process each commenter
          for (const commenter of commenters) {
            if (!commenter.displayName || sourceLeadCount >= MAX_LEADS_PER_SOURCE) continue;

            const handle = extractHandle(commenter.channelUrl) || commenter.displayName.replace(/\s+/g, '');
            const usernameLower = handle.toLowerCase();

            // Skip duplicates
            if (existingUsernames.has(usernameLower)) continue;

            // Score calculation
            const baseScore = sourceType === 'keyword'
              ? SCORE_VIDEO_COMMENTER
              : SCORE_CHANNEL_COMMENTER;
            let score = baseScore;
            const notes = [];

            // Source info
            const sourceLabel = sourceType === 'keyword'
              ? `${query} | ${video.title.substring(0, 50)}`
              : query;
            notes.push(`YT commenter | video: ${video.title.substring(0, 80)}`);

            // Purchase signal check
            const purchaseSignal = checkPurchaseSignal(commenter.commentText);
            if (purchaseSignal) {
              score += SCORE_PURCHASE_SIGNAL;
              notes.push(`PURCHASE_SIGNAL: "${purchaseSignal}"`);
            }

            // Geo check
            const geoMention = checkGeoMention(commenter.commentText);
            if (geoMention) {
              score += SCORE_GEO_BONUS;
              notes.push(`UAE:yes (comment-geo: ${geoMention})`);
            }

            const lead = {
              id: idCounter++,
              username: handle,
              platform: 'youtube',
              profile_url: commenter.channelUrl || '',
              follower_count: null,
              following_count: null,
              bio_snippet: commenter.commentText.substring(0, 150),
              location: geoMention ? 'UAE' : '',
              source_handle: sourceLabel,
              source_type: sourceType === 'keyword'
                ? 'youtube_video_commenter'
                : 'youtube_channel_commenter',
              total_score: score,
              engagement_stage: 0,
              is_influencer: 0,
              notes: notes.join(', '),
              created_at: new Date().toISOString(),
              last_engaged_at: null,
              updated_at: new Date().toISOString(),
              is_do_not_engage: false,
              coupon_referenced: 0,
              coupon_code: null,
              dm_pivot_attempted: 0,
              dm_channel: null,
            };

            leads.push(lead);
            existingUsernames.add(usernameLower);
            sourceLeadCount++;
            totalNewLeads++;

            // Append to outreach log
            appendOutreachLog({
              timestamp: new Date().toISOString(),
              action_type: 'discovery',
              platform: 'youtube',
              username: handle,
              source_type: lead.source_type,
              source_handle: sourceLabel,
              score,
              brief_id: null,
            });
          }

          // Save leads every 5 videos
          if ((vi + 1) % 5 === 0 || vi === videoLinks.length - 1) {
            saveLeads(leads);
            log('video', `    Saved leads.json (${leads.length} total, ${sourceLeadCount} new from this source)`);
          }

        } catch (e) {
          log('video', `    ERROR scraping video: ${e.message}`);
          try {
            await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `yt-error-${vi}-${Date.now()}.png`) });
          } catch {}
        }

        // Random delay between videos
        const delay = rnd(3000, 6000);
        await sleep(delay);
      }

      // Final save for this source
      saveLeads(leads);
      log('source', `  Source "${query}" done: ${sourceLeadCount} new leads`);

      // Delay between sources
      if (si < SOURCES.length - 1) {
        const sourceDelay = rnd(5000, 10000);
        log('source', `  Waiting ${Math.round(sourceDelay / 1000)}s before next source…`);
        await sleep(sourceDelay);
      }
    }

    // ── Final screenshot ────────────────────────────────────────────────────
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `yt-done-${Date.now()}.png`) });

    // ── Summary ─────────────────────────────────────────────────────────────
    const finalLeads = loadLeads();
    const ytLeads = finalLeads.filter(l => l.platform === 'youtube');

    console.log('\n=== YOUTUBE SCRAPE SUMMARY ===');
    console.log(`Sources processed: ${SOURCES.length}`);
    console.log(`New leads found:   ${totalNewLeads}`);
    console.log(`Total YT leads:    ${ytLeads.length}`);
    console.log(`Total pipeline:    ${finalLeads.length}`);
    console.log('==============================');

  } catch (e) {
    log('fatal', e.message);
    log('fatal', e.stack);
    try {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `yt-fatal-${Date.now()}.png`) });
    } catch {}
    await context.close();
    process.exit(1);
  }

  await context.close();
  process.exit(totalNewLeads > 0 ? 0 : 1);
})();
