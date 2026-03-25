#!/usr/bin/env node
/**
 * scrape-facebook.js — Extract leads from Facebook Groups (member groups only).
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/scrape-facebook.js
 *
 * Scrapes post authors and commenters from member groups who are asking
 * sleep/wellness/bedding questions. Leads enter at stage 0 with ig_checked=false
 * and are later cross-matched to Instagram via youtube-to-instagram.js.
 *
 * Required env vars:
 *   FB_SESSION_DIR   — persistent Facebook browser session path
 *   FB_GROUPS_FILE   — absolute path to facebook-groups.json
 *   LEADS_FILE       — absolute path to leads.json
 *   CLIENT_ID        — client identifier
 *
 * Optional env vars:
 *   PROXY            — proxy URL (required for UAE geo)
 *   OUTREACH_LOG     — path to outreach-log.ndjson
 *   SCREENSHOTS_DIR  — where to save screenshots (default: /tmp)
 *   MAX_POSTS_PER_GROUP  — max posts to inspect per group (default: 30)
 *   MAX_LEADS_PER_RUN    — stop adding leads after this many new leads (default: 50)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const FB_SESSION_DIR      = process.env.FB_SESSION_DIR      || '';
const FB_GROUPS_FILE      = process.env.FB_GROUPS_FILE      || '';
const LEADS_FILE          = process.env.LEADS_FILE          || '';
const CLIENT_ID           = process.env.CLIENT_ID           || '';
const PROXY               = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const OUTREACH_LOG        = process.env.OUTREACH_LOG        || '';
const SCREENSHOTS_DIR     = process.env.SCREENSHOTS_DIR     || '/tmp';
const MAX_POSTS_PER_GROUP = parseInt(process.env.MAX_POSTS_PER_GROUP || '30', 10);
const MAX_LEADS_PER_RUN   = parseInt(process.env.MAX_LEADS_PER_RUN  || '50', 10);

if (!FB_SESSION_DIR || !FB_GROUPS_FILE || !LEADS_FILE || !CLIENT_ID) {
  console.error('[fb-scrape] ERROR: FB_SESSION_DIR, FB_GROUPS_FILE, LEADS_FILE, CLIENT_ID required');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Sleep and wellness keywords (EN + AR)
const SLEEP_KEYWORDS = [
  'sleep', 'sheets', 'bedding', 'mattress', 'pillow', 'hot at night', 'night sweat',
  'waking up', 'insomnia', 'bedroom', 'duvet', 'linen', 'cotton', 'bamboo', 'thread count',
  'humid', 'sweating', 'heat', 'air conditioning', 'cooling',
  'interior', 'decor', 'furniture', 'home', 'design',
  'نوم', 'شراشف', 'مرتبة', 'وسادة', 'حر', 'تعرق', 'أرق', 'غرفة نوم', 'غطاء', 'مفرش', 'فراش',
  'ديكور', 'أثاث', 'منزل', 'غرفة', 'تصميم', 'سرير', 'ترتيب', 'فرشة', 'بطانية',
];

// Groups where ALL posts are relevant — every member is a potential buyer
const HIGH_INTENT_GROUP_KEYWORDS = [
  'نوم', 'sleep', 'bedroom', 'غرف', 'insomnia', 'أرق', 'bedding', 'mattress', 'مرتبة',
  'interior', 'ديكور', 'home', 'منزل', 'سيدات', 'women',
];

// High intent bonus keywords
const PURCHASE_SIGNALS = [
  'recommend', 'where to buy', 'best', 'worth it', 'tried', 'review', 'switched',
  'looking for', 'anyone know', 'suggestion', 'advice',
  'توصية', 'وين', 'أفضل', 'تجربة', 'بحث',
];

function loadGroups() {
  try { return JSON.parse(fs.readFileSync(FB_GROUPS_FILE, 'utf8')); } catch { return []; }
}

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch { return []; }
}
function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function logOutreach(entry) {
  if (!OUTREACH_LOG) return;
  try { fs.appendFileSync(OUTREACH_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'); } catch {}
}

function isRelevantPost(text) {
  const lower = text.toLowerCase();
  return SLEEP_KEYWORDS.some(kw => lower.includes(kw));
}

function hasPurchaseSignal(text) {
  const lower = text.toLowerCase();
  return PURCHASE_SIGNALS.some(kw => lower.includes(kw));
}

for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(FB_SESSION_DIR, f)); } catch (e) { if (e.code !== 'ENOENT') {} }
}

(async () => {
  const groups = loadGroups();
  const memberGroups = groups.filter(g => g.status === 'member');

  if (!memberGroups.length) {
    console.log('[fb-scrape] No member groups — run facebook-group-monitor.js first');
    process.exit(0);
  }

  console.log(`[fb-scrape] Scraping ${memberGroups.length} member group(s)…`);

  const options = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
  };
  if (PROXY) {
    const proxyUrl = PROXY.includes('://') ? PROXY : 'http://' + PROXY;
    const u = new URL(proxyUrl);
    options.proxy = { server: u.protocol + '//' + u.host };
    if (u.username) options.proxy.username = decodeURIComponent(u.username);
    if (u.password) options.proxy.password = decodeURIComponent(u.password);
  }

  const browser = await chromium.launchPersistentContext(FB_SESSION_DIR, options);
  const page = browser.pages()[0] || await browser.newPage();

  // Verify session
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    if (page.url().includes('/login')) {
      console.error('[fb-scrape] ERROR: Facebook session not logged in — stopping');
      await browser.close();
      process.exit(1);
    }
    console.log('[fb-scrape] Facebook session active');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `fb-scrape-start-${Date.now()}.png`) });
  } catch (e) {
    console.error('[fb-scrape] ERROR loading Facebook:', e.message);
    await browser.close();
    process.exit(1);
  }

  let totalNewLeads = 0;

  for (const group of memberGroups) {
    if (totalNewLeads >= MAX_LEADS_PER_RUN) break;
    const groupLabel = group.group_name || group.group_url || '';
    const groupKeyword = (group.keyword || '').toLowerCase();
    // High-intent: scrape ALL post authors (no keyword filter) when:
    // - group name or search keyword mentions sleep/bedroom/decor/women
    // - OR the search keyword is NOT a URL (i.e. it's a meaningful search term)
    const keywordIsUrl = groupKeyword.startsWith('http') || groupKeyword.includes('facebook.com');
    const isHighIntent = !keywordIsUrl || HIGH_INTENT_GROUP_KEYWORDS.some(kw =>
      groupLabel.toLowerCase().includes(kw.toLowerCase()) ||
      groupKeyword.includes(kw.toLowerCase())
    );
    console.log(`\n[fb-scrape] Group: ${groupLabel} | keyword: "${groupKeyword.slice(0,40)}" | high-intent: ${isHighIntent}`);

    try {
      await page.goto(group.group_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(4000);

      // Dismiss popups
      try {
        const closeBtn = page.locator('[aria-label="Close"]').first();
        if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await closeBtn.click();
          await sleep(1000);
        }
      } catch {}

      // Scroll to load posts
      for (let s = 0; s < 5; s++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await sleep(2000);
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `fb-scrape-group-${Date.now()}.png`) });

      // Extract post authors + text from articles
      const articles = await page.$$('[role="article"]');
      console.log(`[fb-scrape] Found ${articles.length} articles`);

      const leads    = loadLeads();
      const existing = new Set(leads.map(l => `${l.platform}:${l.username?.toLowerCase()}`));
      let nextId     = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
      let groupLeads = 0;

      for (let ai = 0; ai < Math.min(articles.length, MAX_POSTS_PER_GROUP); ai++) {
        if (totalNewLeads >= MAX_LEADS_PER_RUN) break;

        try {
          const article = articles[ai];

          // Get post text
          const postText = await article.$eval(
            '[data-ad-comet-preview="message"], [dir="auto"]',
            el => el.textContent?.trim() || ''
          ).catch(() => '');

          if (!postText && !isHighIntent) continue;
          if (postText && !isHighIntent && !isRelevantPost(postText)) continue;

          // Get post author via page.evaluate — more reliable on FB's obfuscated DOM
          const authorData = await article.evaluate(el => {
            const links = Array.from(el.querySelectorAll('a[href]'));
            const SKIP = ['/groups/', '/pages/', '/hashtag/', '/photo', '/video', '/posts/', '/events/', '/marketplace/'];
            for (const a of links) {
              const href = a.href || '';
              const name = (a.textContent || '').trim();
              if (!href || !name || name.length < 2 || name.length > 60) continue;
              if (SKIP.some(s => href.includes(s))) continue;
              // Match profile patterns
              if (href.includes('/user/') || href.includes('profile.php') ||
                  /facebook\.com\/[a-zA-Z0-9._]{2,}(\/|$)/.test(href)) {
                return { href, name };
              }
            }
            return null;
          }).catch(() => null);

          if (!authorData) continue;
          let { href: authorUrl, name: authorName } = authorData;

          // Resolve relative URLs
          if (authorUrl.startsWith('/')) authorUrl = 'https://www.facebook.com' + authorUrl;

          // Parse username from URL
          let fbUsername = authorUrl.match(/facebook\.com\/([^/?#]+)/)?.[1] || '';
          if (!fbUsername || ['groups', 'pages', 'events', 'marketplace', 'watch'].includes(fbUsername)) continue;
          // profile.php?id=NNNNN — use numeric ID as username
          if (fbUsername === 'profile.php') {
            const uid = authorUrl.match(/id=(\d+)/)?.[1];
            fbUsername = uid ? `uid_${uid}` : authorName.trim().replace(/\s+/g, '.').toLowerCase();
          }

          const key = `facebook:${fbUsername.toLowerCase()}`;
          if (existing.has(key)) continue;

          const hasPurchase = hasPurchaseSignal(postText);
          const score = 35 + (hasPurchase ? 15 : 0);

          const lead = {
            id:              nextId++,
            username:        fbUsername,
            display_name:    authorName,
            platform:        'facebook',
            profile_url:     authorUrl,
            follower_count:  null,
            bio_snippet:     postText.substring(0, 200),
            source_handle:   group.group_name,
            source_type:     'facebook_group_post',
            total_score:     score,
            engagement_stage: 0,
            ig_checked:      false,
            notes:           `FB group: ${group.group_name} | post: "${postText.substring(0, 100)}"`,
            created_at:      new Date().toISOString(),
            updated_at:      new Date().toISOString(),
            last_engaged_at: null,
            is_do_not_engage: false,
            coupon_referenced: 0,
            coupon_code:     null,
            dm_pivot_attempted: 0,
            dm_channel:      null,
          };

          leads.push(lead);
          existing.add(key);
          groupLeads++;
          totalNewLeads++;

          logOutreach({
            action_type:  'discovery',
            platform:     'facebook',
            username:     fbUsername,
            source_type:  'facebook_group_post',
            source_handle: group.group_name,
            score,
            client_id:    CLIENT_ID,
          });

          // Also extract commenters on relevant posts
          try {
            // Click "View more comments" if visible
            const moreComments = article.locator('div[role="button"]:has-text("comment"), span:has-text("View more")').first();
            if (await moreComments.isVisible({ timeout: 2000 }).catch(() => false)) {
              await moreComments.click();
              await sleep(2000);
            }

            const commentEls = await article.$$('[role="article"] a[href*="facebook.com"]');
            for (const commentEl of commentEls.slice(0, 10)) {
              const cUrl  = await commentEl.getAttribute('href') || '';
              const cName = (await commentEl.textContent())?.trim() || '';
              if (!cUrl || !cName || cName.length < 2) continue;

              let cUsername = cUrl.match(/facebook\.com\/([^/?#]+)/)?.[1] || '';
              if (!cUsername || cUsername === 'groups' || cUsername === 'profile.php') continue;

              const cKey = `facebook:${cUsername.toLowerCase()}`;
              if (existing.has(cKey)) continue;

              leads.push({
                id:              nextId++,
                username:        cUsername,
                display_name:    cName,
                platform:        'facebook',
                profile_url:     cUrl,
                follower_count:  null,
                bio_snippet:     '',
                source_handle:   group.group_name,
                source_type:     'facebook_group_commenter',
                total_score:     25,
                engagement_stage: 0,
                ig_checked:      false,
                notes:           `FB commenter | group: ${group.group_name} | on post: "${postText.substring(0, 60)}"`,
                created_at:      new Date().toISOString(),
                updated_at:      new Date().toISOString(),
                last_engaged_at: null,
                is_do_not_engage: false,
                coupon_referenced: 0,
                coupon_code:     null,
                dm_pivot_attempted: 0,
                dm_channel:      null,
              });
              existing.add(cKey);
              totalNewLeads++;

              if (totalNewLeads >= MAX_LEADS_PER_RUN) break;
            }
          } catch {}

        } catch (e) {
          // Skip article on error
        }

        await sleep(rnd(1000, 2000));
      }

      saveLeads(leads);
      console.log(`[fb-scrape] ${groupLeads} new leads from: ${group.group_name}`);

    } catch (e) {
      console.error(`[fb-scrape] ERROR on ${group.group_name}: ${e.message}`);
    }

    await sleep(rnd(8000, 15000));
  }

  await browser.close();

  const finalLeads = loadLeads();
  const fbLeads = finalLeads.filter(l => l.platform === 'facebook');
  console.log('\n=== FACEBOOK SCRAPE SUMMARY ===');
  console.log(`New leads found:  ${totalNewLeads}`);
  console.log(`Total FB leads:   ${fbLeads.length}`);
  console.log(`Total pipeline:   ${finalLeads.length}`);
  console.log('================================');
  process.exit(0);
})();
