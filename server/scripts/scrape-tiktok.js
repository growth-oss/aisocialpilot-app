#!/usr/bin/env node
/**
 * scrape-tiktok.js — TikTok lead discovery (public content, no login required).
 *
 * NEVER write this script from a Claude run — it is version-controlled.
 * Claude should call it with: node /app/server/scripts/scrape-tiktok.js
 *
 * Same pattern as scrape-youtube.js. Saves username + comment_text per lead
 * so youtube-to-instagram.js can cross-match them to Instagram later.
 *
 * Required env vars:
 *   LEADS_FILE    — absolute path to leads.json
 *   SOURCES       — JSON array: [{type, handle_or_url, why}]  type='keyword'|'account'
 *   CLIENT_ID     — client identifier
 *
 * Optional env vars:
 *   MAX_VIDEOS_PER_SOURCE    — max videos to scrape per source (default: 8)
 *   MAX_COMMENTERS_PER_VIDEO — max commenters per video (default: 20)
 *   MAX_LEADS_PER_SOURCE     — stop after this many per source (default: 80)
 *   SCREENSHOTS_DIR          — where to save screenshots (default: /tmp)
 *   OUTREACH_LOG             — path to outreach-log.ndjson
 *   SCORE_COMMENTER          — base score for commenters (default: 25)
 *   SCORE_PURCHASE_SIGNAL    — bonus for purchase intent (default: 15)
 *   SCORE_GEO_BONUS          — bonus for UAE mention (default: 15)
 *
 * NOTE: TikTok scraping does NOT use proxy or require a session — public content.
 * TikTok leads are DISCOVERY ONLY (stage 0). They advance via cross-match on
 * Instagram (youtube-to-instagram.js also handles tiktok platform leads).
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const LEADS_FILE               = process.env.LEADS_FILE || '';
const SOURCES                  = JSON.parse(process.env.SOURCES || '[]');
const CLIENT_ID                = process.env.CLIENT_ID || '';
const MAX_VIDEOS_PER_SOURCE    = parseInt(process.env.MAX_VIDEOS_PER_SOURCE || '8', 10);
const MAX_COMMENTERS_PER_VIDEO = parseInt(process.env.MAX_COMMENTERS_PER_VIDEO || '20', 10);
const MAX_LEADS_PER_SOURCE     = parseInt(process.env.MAX_LEADS_PER_SOURCE || '80', 10);
const SCREENSHOTS_DIR          = process.env.SCREENSHOTS_DIR || '/tmp';
const OUTREACH_LOG             = process.env.OUTREACH_LOG || '';
const SCORE_COMMENTER          = parseInt(process.env.SCORE_COMMENTER || '25', 10);
const SCORE_PURCHASE_SIGNAL    = parseInt(process.env.SCORE_PURCHASE_SIGNAL || '15', 10);
const SCORE_GEO_BONUS          = parseInt(process.env.SCORE_GEO_BONUS || '15', 10);

if (!LEADS_FILE || !SOURCES.length || !CLIENT_ID) {
  console.error('[tiktok] Missing required env vars: LEADS_FILE, SOURCES, CLIENT_ID');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const PURCHASE_SIGNALS = [
  'where to buy', 'where can i buy', 'price', 'how much', 'link', 'recommend',
  'worth it', 'ordered', 'just bought', 'want to buy', 'looking for', 'need this',
  'shipping', 'delivery', 'discount', 'coupon', 'store', 'shop',
  'وين أشتري', 'كم سعر', 'السعر', 'رابط', 'أبي أشتري', 'طلبت', 'فين', 'محل',
];

const GEO_KEYWORDS = [
  'uae', 'dubai', 'abu dhabi', 'sharjah', 'ajman', 'ras al khaimah', 'fujairah',
  'الإمارات', 'دبي', 'أبوظبي', 'الشارقة', 'عجمان',
];

function checkPurchaseSignal(text) {
  const lower = text.toLowerCase();
  for (const s of PURCHASE_SIGNALS) { if (lower.includes(s)) return s; }
  return null;
}

function checkGeoMention(text) {
  const lower = text.toLowerCase();
  for (const g of GEO_KEYWORDS) { if (lower.includes(g)) return g; }
  return null;
}

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch { return []; }
}

function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function appendOutreachLog(entry) {
  if (!OUTREACH_LOG) return;
  try { fs.appendFileSync(OUTREACH_LOG, JSON.stringify(entry) + '\n'); } catch {}
}

async function dismissPopups(page) {
  const dismissSelectors = [
    '[data-e2e="modal-close-inner-button"]',
    'button[aria-label="Close"]',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    '[data-e2e="cookie-banner-accept"]',
  ];
  for (const sel of dismissSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click();
        await sleep(800);
      }
    } catch {}
  }
}

(async () => {
  // No proxy, no session — TikTok public content
  const context = await chromium.launchPersistentContext('/tmp/tiktok-scrape-session', {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = context.pages()[0] || await context.newPage();
  let totalNewLeads = 0;

  try {
    // Load TikTok and dismiss consent
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    await dismissPopups(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `tt-start-${Date.now()}.png`) });
    console.log('[tiktok] TikTok loaded');

    for (let si = 0; si < SOURCES.length; si++) {
      const source = SOURCES[si];
      const sourceType = source.type;
      const query = source.handle_or_url;
      console.log(`\n[tiktok] [${si + 1}/${SOURCES.length}] ${sourceType}: "${query}"`);

      let videoLinks = [];

      if (sourceType === 'keyword') {
        const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(4000);
        await dismissPopups(page);

        // Scroll to load more results
        for (let s = 0; s < 4; s++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await sleep(1800);
        }

        // Extract video links — multiple fallback selectors
        videoLinks = await page.$$eval(
          'a[href*="/video/"]',
          (els, max) => {
            const seen = new Set();
            const out = [];
            for (const a of els) {
              const href = a.href || '';
              if (!href.match(/\/video\/\d+/)) continue;
              if (seen.has(href)) continue;
              seen.add(href);
              // Try to grab nearby text as title
              const card = a.closest('[class]') || a.parentElement;
              const title = card?.querySelector('[class*="desc"], [class*="text"], p')?.textContent?.trim() || '';
              out.push({ url: href, title: title.substring(0, 100) });
              if (out.length >= max) break;
            }
            return out;
          },
          MAX_VIDEOS_PER_SOURCE
        ).catch(() => []);
        console.log(`[tiktok]   Found ${videoLinks.length} videos from search`);

      } else if (sourceType === 'account') {
        const handle = query.startsWith('@') ? query : '@' + query;
        await page.goto(`https://www.tiktok.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
        await dismissPopups(page);

        for (let s = 0; s < 3; s++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await sleep(1500);
        }

        videoLinks = await page.$$eval(
          'a[href*="/video/"]',
          (els, max) => {
            const seen = new Set();
            return els.reduce((acc, a) => {
              const href = a.href || '';
              if (!href.match(/\/video\/\d+/) || seen.has(href)) return acc;
              seen.add(href);
              acc.push({ url: href, title: a.title || a.textContent?.trim() || '' });
              return acc;
            }, []).slice(0, max);
          },
          MAX_VIDEOS_PER_SOURCE
        ).catch(() => []);
        console.log(`[tiktok]   Found ${videoLinks.length} videos from account`);
      } else {
        console.log(`[tiktok]   Unknown source type "${sourceType}" — skipping`);
        continue;
      }

      if (!videoLinks.length) {
        console.log(`[tiktok]   No videos found — skipping source`);
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `tt-nosource-${si}-${Date.now()}.png`) });
        continue;
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `tt-source-${si}-${Date.now()}.png`) });

      let sourceLeadCount = 0;
      const leads = loadLeads();
      const existingUsernames = new Set(leads.map(l => l.username?.toLowerCase()));
      let idCounter = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;

      for (let vi = 0; vi < videoLinks.length && sourceLeadCount < MAX_LEADS_PER_SOURCE; vi++) {
        const video = videoLinks[vi];
        console.log(`[tiktok]   [${vi + 1}/${videoLinks.length}] "${video.title.substring(0, 60)}"`);

        try {
          await page.goto(video.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(4000);
          await dismissPopups(page);

          // Scroll to load comments
          for (let s = 0; s < 5; s++) {
            await page.evaluate(() => window.scrollBy(0, 600));
            await sleep(1800);
          }

          // Extract commenters — TikTok DOM uses data-e2e attributes
          const commenters = await page.$$eval(
            '[data-e2e="comment-item"], [class*="DivCommentItemWrapper"], [class*="comment-item"]',
            (els, max) => els.slice(0, max).map(el => {
              // Username from link or text
              const userLink = el.querySelector('a[href*="/@"], [data-e2e="comment-username-link"]');
              const username = userLink?.href?.match(/\/@([^/?#]+)/)?.[1]
                || userLink?.textContent?.trim()
                || '';
              // Comment text
              const textEl = el.querySelector('[data-e2e="comment-text"], p[class*="SpanText"], p, span[class*="text"]');
              const commentText = textEl?.textContent?.trim() || '';
              return { username, commentText };
            }).filter(c => c.username && c.username.length > 1),
            MAX_COMMENTERS_PER_VIDEO
          ).catch(() => []);

          console.log(`[tiktok]     ${commenters.length} commenters extracted`);

          for (const c of commenters) {
            if (sourceLeadCount >= MAX_LEADS_PER_SOURCE) break;
            const usernameLower = c.username.toLowerCase();
            if (existingUsernames.has(usernameLower)) continue;

            let score = SCORE_COMMENTER;
            const notes = [];

            const purchaseSignal = checkPurchaseSignal(c.commentText);
            if (purchaseSignal) {
              score += SCORE_PURCHASE_SIGNAL;
              notes.push(`PURCHASE_SIGNAL: "${purchaseSignal}"`);
            }

            const geoMention = checkGeoMention(c.commentText);
            if (geoMention) {
              score += SCORE_GEO_BONUS;
              notes.push(`UAE:yes`);
            }

            const sourceLabel = `${query} | ${video.title.substring(0, 50)}`;

            const lead = {
              id: idCounter++,
              username: c.username,
              platform: 'tiktok',
              profile_url: `https://www.tiktok.com/@${c.username}`,
              follower_count: null,
              following_count: null,
              bio_snippet: c.commentText.substring(0, 150),
              location: geoMention ? 'UAE' : '',
              source_handle: sourceLabel,
              source_type: 'tiktok_video_commenter',
              total_score: score,
              engagement_stage: 0,
              is_influencer: 0,
              notes: notes.join(', '),
              video_url:    video.url,
              video_title:  video.title.substring(0, 150),
              comment_text: c.commentText.substring(0, 500),
              created_at: new Date().toISOString(),
              last_engaged_at: null,
              updated_at: new Date().toISOString(),
              is_do_not_engage: false,
              coupon_referenced: 0,
              coupon_code: null,
              ig_checked: false,
              tt_replied: false,
            };

            leads.push(lead);
            existingUsernames.add(usernameLower);
            sourceLeadCount++;
            totalNewLeads++;

            appendOutreachLog({
              timestamp: new Date().toISOString(),
              action_type: 'discovery',
              platform: 'tiktok',
              username: c.username,
              source_type: 'tiktok_video_commenter',
              source_handle: sourceLabel,
              score,
              brief_id: null,
            });
          }

          if ((vi + 1) % 3 === 0 || vi === videoLinks.length - 1) {
            saveLeads(leads);
            console.log(`[tiktok]     Saved (${leads.length} total, ${sourceLeadCount} new this source)`);
          }

        } catch (e) {
          console.error(`[tiktok]     ERROR on video: ${e.message}`);
          try { await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `tt-err-${vi}-${Date.now()}.png`) }); } catch {}
        }

        await sleep(rnd(4000, 8000));
      }

      saveLeads(leads);
      console.log(`[tiktok]   Source "${query}" done: ${sourceLeadCount} new leads`);

      if (si < SOURCES.length - 1) await sleep(rnd(5000, 10000));
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `tt-done-${Date.now()}.png`) });

    const finalLeads = loadLeads();
    const ttLeads = finalLeads.filter(l => l.platform === 'tiktok');
    console.log('\n=== TIKTOK SCRAPE SUMMARY ===');
    console.log(`Sources processed: ${SOURCES.length}`);
    console.log(`New leads found:   ${totalNewLeads}`);
    console.log(`Total TikTok leads: ${ttLeads.length}`);
    console.log(`Total pipeline:    ${finalLeads.length}`);
    console.log('==============================');

  } catch (e) {
    console.error('[tiktok] FATAL:', e.message, e.stack);
    try { await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `tt-fatal-${Date.now()}.png`) }); } catch {}
    await context.close();
    process.exit(1);
  }

  await context.close();
  process.exit(totalNewLeads > 0 ? 0 : 1);
})();
