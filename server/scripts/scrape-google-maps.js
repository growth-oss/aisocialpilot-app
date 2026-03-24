#!/usr/bin/env node
/**
 * scrape-google-maps.js — Extract B2B leads from Google Maps business listings.
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/scrape-google-maps.js
 *
 * Targets bulk bedding buyers: hotels, resorts, serviced apartments, interior designers,
 * property developers, and home furnishing stores in UAE.
 * No login, no proxy required — Google Maps is public.
 *
 * Leads saved with platform='google_maps'. These are B2B leads — they do NOT go
 * through the Instagram cross-match flow. Outreach is via LinkedIn or website contact.
 *
 * Required env vars:
 *   MAPS_SOURCES  — JSON array: [{type:"keyword", handle_or_url:"hotel Dubai", why:"..."}]
 *   LEADS_FILE    — absolute path to leads.json
 *   CLIENT_ID     — client identifier
 *
 * Optional env vars:
 *   SCREENSHOTS_DIR        — where to save screenshots (default: /tmp)
 *   OUTREACH_LOG           — path to outreach-log.ndjson
 *   MAX_RESULTS_PER_SOURCE — max business listings per keyword (default: 20)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const MAPS_SOURCES           = JSON.parse(process.env.MAPS_SOURCES || '[]');
const LEADS_FILE             = process.env.LEADS_FILE             || '';
const CLIENT_ID              = process.env.CLIENT_ID              || '';
const SCREENSHOTS_DIR        = process.env.SCREENSHOTS_DIR        || '/tmp';
const OUTREACH_LOG           = process.env.OUTREACH_LOG           || '';
const MAX_RESULTS_PER_SOURCE = parseInt(process.env.MAX_RESULTS_PER_SOURCE || '20', 10);

if (!MAPS_SOURCES.length || !LEADS_FILE || !CLIENT_ID) {
  console.error('[maps] ERROR: MAPS_SOURCES, LEADS_FILE, and CLIENT_ID are required');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── B2B scoring by business category ──────────────────────────────────────────
const CATEGORY_SCORES = {
  hotel:              50,
  resort:             50,
  'serviced apartment': 50,
  'hotel apartment':  50,
  'furnished apartment': 45,
  'interior design':  40,
  'interior designer': 40,
  'property developer': 40,
  'real estate developer': 40,
  'home furnishing':  45,
  'furniture store':  45,
  'bedding':          45,
  'home decor':       30,
  'home goods':       30,
  'spa':              30,
  wellness:           25,
  clinic:             20,
};

function scoreByCategory(category) {
  const lower = (category || '').toLowerCase();
  for (const [key, score] of Object.entries(CATEGORY_SCORES)) {
    if (lower.includes(key)) return score;
  }
  return 15; // generic business
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

(async () => {
  // No proxy, no session needed — Google Maps is public
  const browser = await chromium.launchPersistentContext('/tmp/maps-scrape-session', {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US',
    ],
    locale: 'en-US',
  });

  const page = browser.pages()[0] || await browser.newPage();

  // Dismiss cookie banner
  try {
    await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const acceptBtn = page.locator('button:has-text("Accept all"), button:has-text("I agree")').first();
    if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await acceptBtn.click();
      await sleep(1500);
    }
  } catch {}

  let totalNewLeads = 0;

  for (let si = 0; si < MAPS_SOURCES.length; si++) {
    const source = MAPS_SOURCES[si];
    const query  = source.handle_or_url || source.keyword || '';
    if (!query) continue;

    console.log(`\n[maps] [${si + 1}/${MAPS_SOURCES.length}] Searching: "${query}"`);

    try {
      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4000);

      // Wait for results panel
      try {
        await page.waitForSelector('[role="feed"], div[aria-label*="Results"]', { timeout: 15000 });
      } catch {
        console.log(`[maps] No results panel for "${query}" — skipping`);
        continue;
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `maps-search-${si}-${Date.now()}.png`) });

      // Scroll results panel to load more listings
      const resultsPanel = page.locator('[role="feed"]').first();
      for (let s = 0; s < 4; s++) {
        try {
          await resultsPanel.evaluate(el => el.scrollBy(0, 600));
        } catch {
          await page.evaluate(() => window.scrollBy(0, 600));
        }
        await sleep(2000);
      }

      // Extract business cards from the results list
      const listings = await page.$$eval(
        '[role="feed"] > div, [role="article"]',
        (els, max) => els.slice(0, max).map(el => {
          const name     = el.querySelector('div[aria-label] span:first-child, h3, [data-value]')?.textContent?.trim() || '';
          const category = el.querySelector('button[jsaction*="category"], span.fontBodyMedium')?.textContent?.trim() || '';
          const rating   = el.querySelector('span[aria-label*="stars"]')?.getAttribute('aria-label') || '';
          const address  = el.querySelectorAll('span.fontBodyMedium')[1]?.textContent?.trim() || '';
          const link     = el.querySelector('a[href*="/maps/place/"]');
          const href     = link ? link.href : '';
          return { name, category, rating, address, href };
        }).filter(l => l.name && l.href),
        MAX_RESULTS_PER_SOURCE
      ).catch(() => []);

      console.log(`[maps] Found ${listings.length} listings`);

      const leads  = loadLeads();
      const existing = new Set(leads.map(l => `google_maps:${l.username?.toLowerCase()}`));
      let nextId   = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
      let srcLeads = 0;

      for (const listing of listings) {
        if (!listing.name) continue;

        // Use business name as username slug
        const slug = listing.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
        const key  = `google_maps:${slug}`;
        if (existing.has(key)) continue;

        // Click listing to get more details (website, phone)
        let website = '';
        let phone   = '';
        try {
          const listingLink = page.locator(`a[href="${listing.href}"]`).first();
          if (await listingLink.isVisible({ timeout: 2000 }).catch(() => false)) {
            await listingLink.click();
            await sleep(3000);

            // Extract website
            const websiteEl = page.locator('a[data-item-id="authority"], a[aria-label*="website"]').first();
            if (await websiteEl.isVisible({ timeout: 3000 }).catch(() => false)) {
              website = await websiteEl.getAttribute('href') || '';
            }

            // Extract phone
            const phoneEl = page.locator('[data-item-id^="phone"], button[aria-label*="phone"]').first();
            if (await phoneEl.isVisible({ timeout: 2000 }).catch(() => false)) {
              phone = await phoneEl.getAttribute('aria-label') || '';
              phone = phone.replace(/phone:/i, '').trim();
            }

            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await sleep(2000);
          }
        } catch {}

        const score = scoreByCategory(listing.category);

        const lead = {
          id:              nextId++,
          username:        slug,
          display_name:    listing.name,
          platform:        'google_maps',
          profile_url:     listing.href,
          website,
          phone,
          follower_count:  null,
          bio_snippet:     listing.category,
          location:        listing.address,
          source_handle:   query,
          source_type:     'google_maps_listing',
          total_score:     score,
          engagement_stage: 0,
          ig_checked:      false,
          notes:           `B2B lead | category: ${listing.category} | search: "${query}" | rating: ${listing.rating}`,
          created_at:      new Date().toISOString(),
          updated_at:      new Date().toISOString(),
          last_engaged_at: null,
          is_do_not_engage: false,
          coupon_referenced: 0,
          coupon_code:     null,
          dm_pivot_attempted: 0,
          dm_channel:      'linkedin_or_email',
        };

        leads.push(lead);
        existing.add(key);
        srcLeads++;
        totalNewLeads++;

        logOutreach({
          action_type:  'discovery',
          platform:     'google_maps',
          username:     slug,
          display_name: listing.name,
          source_type:  'google_maps_listing',
          source_handle: query,
          score,
          client_id:    CLIENT_ID,
        });

        console.log(`[maps] ✅ ${listing.name} (${listing.category}) score:${score}`);
        await sleep(rnd(1500, 3000));
      }

      saveLeads(leads);
      console.log(`[maps] Source "${query}": ${srcLeads} new leads`);

    } catch (e) {
      console.error(`[maps] ERROR on "${query}": ${e.message}`);
    }

    await sleep(rnd(5000, 10000));
  }

  await browser.close();

  const finalLeads = loadLeads();
  const mapsLeads  = finalLeads.filter(l => l.platform === 'google_maps');
  console.log('\n=== GOOGLE MAPS SCRAPE SUMMARY ===');
  console.log(`New leads found:     ${totalNewLeads}`);
  console.log(`Total Maps leads:    ${mapsLeads.length}`);
  console.log(`Total pipeline:      ${finalLeads.length}`);
  console.log('==================================');
  process.exit(0);
})();
