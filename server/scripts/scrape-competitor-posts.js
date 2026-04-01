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
// Optional comma-separated list of handles to restrict this run to a subset of competitors
const FILTER_HANDLES       = process.env.FILTER_HANDLES
  ? new Set(process.env.FILTER_HANDLES.split(',').map(h => h.trim().replace(/^@/, '').toLowerCase()))
  : null;
// Set FORCE_RESCRAPE=1 to ignore the 30-day cache and re-scrape all posts
const FORCE_RESCRAPE       = process.env.FORCE_RESCRAPE === '1';

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
 * Fetch post data directly from Instagram's web API using the browser context's
 * cookie store (session is already logged in via the persistent context).
 * Uses context.request so cookies are sent automatically — no page navigation needed.
 * Falls back to an empty array on any error; caller then uses getPostsViaDom().
 */
async function getProfilePostsViaApi(context, handle) {
  // X-IG-App-ID is Instagram's public web app identifier — required for the API to respond
  const IG_APP_ID = '936619743392459';

  // Try web_profile_info first (returns edge_owner_to_timeline_media with captions + counts)
  try {
    const resp = await context.request.get(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
      {
        headers: {
          'X-IG-App-ID':      IG_APP_ID,
          'Accept':           '*/*',
          'Accept-Language':  'en-US,en;q=0.9,ar;q=0.8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer':          `https://www.instagram.com/${handle}/`,
        },
        timeout: 15000,
      }
    );

    if (resp.ok()) {
      const data = await resp.json().catch(() => null);
      if (data) {
        // Response shape: { user: { edge_owner_to_timeline_media: { edges: [...] } } }
        const user  = data?.user || data?.data?.user; // handle both with and without data wrapper
        const edges = user?.edge_owner_to_timeline_media?.edges;
        const etmCount = user?.edge_owner_to_timeline_media?.count ?? 0;
        if (Array.isArray(edges) && edges.length > 0) {
          const posts = edges.slice(0, POSTS_PER_ACCOUNT).map(e => shapeProfileInfoNode(e.node || {}, handle));
          console.log(`[ci-scrape]   @${handle} — ${posts.length} posts via web_profile_info ✅`);
          return posts;
        }
        if (etmCount > 0) {
          // Instagram confirms account has posts but strips edges for automated requests.
          // Caller will get shortcodes from DOM and enrich via per-post fetch.
          console.log(`[ci-scrape]   @${handle} — API has ${etmCount} posts but edges stripped (expected) — falling back to DOM+fetch`);
          return [];
        }
        // Newer format: { user: { media: { items: [...] } } }
        const items = user?.media?.items;
        if (Array.isArray(items) && items.length > 0) {
          const posts = items.slice(0, POSTS_PER_ACCOUNT).map(item => shapeFeedItem(item, handle));
          console.log(`[ci-scrape]   @${handle} — ${posts.length} posts via web_profile_info (v2) ✅`);
          return posts;
        }
        console.log(`[ci-scrape]   @${handle} web_profile_info: no posts found, user keys: ${Object.keys(user || data || {}).join(', ')}`);
      }
    } else {
      console.log(`[ci-scrape]   @${handle} web_profile_info: HTTP ${resp.status()}`);
    }
  } catch (e) {
    console.log(`[ci-scrape]   @${handle} web_profile_info error: ${e.message}`);
  }

  // Fallback: try the feed/user API (requires knowing the numeric user ID — skip for now)
  return [];
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
  const imageUrl  = node.display_url || node.thumbnail_src || '';
  return {
    ownerUsername:  handle,
    competitorName: '', // filled in by caller
    shortCode,
    url:           `https://www.instagram.com/p/${shortCode}/`,
    caption:        caption.slice(0, 500),
    imageUrl,
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
  const imageUrl  =
    item.image_versions2?.candidates?.[0]?.url ||
    item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
    item.display_url || item.thumbnail_src || '';
  return {
    ownerUsername:  handle,
    competitorName: '', // filled in by caller
    shortCode,
    url:           `https://www.instagram.com/p/${shortCode}/`,
    caption:        caption.slice(0, 500),
    imageUrl,
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
 * Fetch full post details (caption, counts, imageUrl) for a single shortCode
 * using page.evaluate(() => fetch(...)) so the request carries the logged-in
 * session cookies. Instagram's ?__a=1&__d=dis endpoint returns JSON for logged-in users.
 * Returns null if the request fails or returns an unexpected format.
 */
async function fetchPostDetails(page, shortCode, debug = false) {
  try {
    const raw = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        const text = await r.text();
        return { status: r.status, body: text };
      } catch (e) { return { status: 0, body: String(e) }; }
    }, `https://www.instagram.com/p/${shortCode}/?__a=1&__d=dis`);

    if (debug || !raw || raw.status !== 200) {
      console.log(`[ci-scrape][DEBUG] /p/${shortCode}/?__a=1 → status=${raw?.status} body=${(raw?.body || '').slice(0, 200)}`);
    }
    if (!raw || raw.status !== 200) return null;

    let data;
    try { data = JSON.parse(raw.body); } catch { return null; }

    if (!data) return null;

    // Mobile API shape: { items: [{ caption:{text}, like_count, comment_count, image_versions2, ... }] }
    const item = Array.isArray(data.items) && data.items[0];
    if (item) {
      const captionText = item.caption?.text || '';
      return {
        caption:      captionText.slice(0, 500),
        imageUrl:     item.image_versions2?.candidates?.[0]?.url ||
                      item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || '',
        likesCount:   item.like_count    ?? 0,
        commentsCount: item.comment_count ?? 0,
        timestamp:    item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
        isSponsored:  item.is_paid_partnership ?? false,
        hashtags:     (captionText.match(/#[\w\u0600-\u06FF]+/g) || []).map(h => h.replace('#', '')).slice(0, 10),
      };
    }

    // GraphQL shape: { graphql: { shortcode_media: { edge_media_to_caption, edge_liked_by, ... } } }
    const gql = data.graphql?.shortcode_media;
    if (gql) {
      const captionText = gql.edge_media_to_caption?.edges?.[0]?.node?.text || '';
      return {
        caption:      captionText.slice(0, 500),
        imageUrl:     gql.display_url || gql.thumbnail_src || '',
        likesCount:   gql.edge_liked_by?.count ?? 0,
        commentsCount: gql.edge_media_to_comment?.count ?? 0,
        timestamp:    gql.taken_at_timestamp ? new Date(gql.taken_at_timestamp * 1000).toISOString() : null,
        isSponsored:  gql.is_paid_partnership ?? false,
        hashtags:     (captionText.match(/#[\w\u0600-\u06FF]+/g) || []).map(h => h.replace('#', '')).slice(0, 10),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * DOM fallback — page must already be on the profile URL.
 * Extracts shortcodes from grid thumbnails only; no captions or counts.
 * Used when the direct API call returns nothing (rate-limited / session issue).
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
        imageUrl:       '',
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
  const enabled = competitors.filter(c => {
    if (!c.instagram || c.hunt_priority === 'disabled') return false;
    if (FILTER_HANDLES) return FILTER_HANDLES.has(c.instagram.replace(/^@/, '').toLowerCase());
    return true;
  });

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
  // FORCE_RESCRAPE=1 ignores the cache entirely (use after scraper upgrades)
  const existing = FORCE_RESCRAPE ? [] : loadExistingPosts();
  const cutoff   = Date.now() - 30 * 86400000;
  const retained = existing.filter(p => new Date(p.scrapedAt || 0).getTime() > cutoff);
  const existingKeys = new Set(retained.map(p => p.shortCode));
  if (FORCE_RESCRAPE) console.log('[ci-scrape] FORCE_RESCRAPE=1 — ignoring cache, re-scraping all posts');

  const newPosts = [];
  let totalScraped = 0;
  let totalMetaAds = 0;

  for (const comp of enabled) {
    const handle = (comp.instagram || '').replace(/^@/, '');
    if (!handle) continue;

    console.log(`\n[ci-scrape] @${handle} (${comp.name}) — priority: ${comp.hunt_priority || 'normal'}`);

    try {
      // ── Step 1: Get posts via direct API call (uses session cookies) ─────
      let profilePosts = await getProfilePostsViaApi(context, handle);

      // Fall back to DOM (navigate to profile page) if API returned nothing
      if (profilePosts.length === 0) {
        await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(3000);
        await dismissOverlays(page);
        profilePosts = await getPostsViaDom(page, handle);

        // Enrich DOM stubs with caption + counts via per-post ?__a=1 fetch
        if (profilePosts.length > 0) {
          console.log(`[ci-scrape]   Enriching ${profilePosts.length} posts via ?__a=1...`);
          let enriched = 0;
          for (let ei = 0; ei < profilePosts.length; ei++) {
            const post = profilePosts[ei];
            const details = await fetchPostDetails(page, post.shortCode, ei === 0); // debug first post only
            if (details) {
              post.caption      = details.caption;
              post.imageUrl     = details.imageUrl;
              post.likesCount   = details.likesCount;
              post.commentsCount = details.commentsCount;
              post.isSponsored  = details.isSponsored;
              post.hashtags     = details.hashtags;
              if (details.timestamp) post.timestamp = details.timestamp;
              enriched++;
            }
            await delay(800 + Math.random() * 700); // ~1s between requests
          }
          console.log(`[ci-scrape]   Enriched ${enriched}/${profilePosts.length} posts ✅`);
        }
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
          imageUrl:       '',
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
