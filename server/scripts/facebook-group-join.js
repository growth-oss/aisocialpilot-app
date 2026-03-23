#!/usr/bin/env node
/**
 * facebook-group-join.js — Search Facebook Groups by keyword and apply to join.
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/facebook-group-join.js
 *
 * Required env vars:
 *   FB_SESSION_DIR   — persistent Facebook browser session path
 *   FB_GROUPS_FILE   — absolute path to facebook-groups.json (created if missing)
 *
 * Optional env vars:
 *   PROXY            — proxy URL (required for UAE geo)
 *   FB_JOIN_KEYWORDS — JSON array of keyword strings to search for groups
 *   SCREENSHOTS_DIR  — where to save screenshots (default: /tmp)
 *   MAX_JOINS        — max new join requests per run (default: 5)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const FB_SESSION_DIR   = process.env.FB_SESSION_DIR   || '';
const FB_GROUPS_FILE   = process.env.FB_GROUPS_FILE   || '';
const PROXY            = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const SCREENSHOTS_DIR  = process.env.SCREENSHOTS_DIR  || '/tmp';
const MAX_JOINS        = parseInt(process.env.MAX_JOINS || '5', 10);
const FB_JOIN_KEYWORDS = JSON.parse(process.env.FB_JOIN_KEYWORDS || '[]');

if (!FB_SESSION_DIR || !FB_GROUPS_FILE) {
  console.error('[fb-join] ERROR: FB_SESSION_DIR and FB_GROUPS_FILE are required');
  process.exit(1);
}

if (!FB_JOIN_KEYWORDS.length) {
  console.log('[fb-join] No FB_JOIN_KEYWORDS set — nothing to search. Exiting.');
  process.exit(0);
}

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(FB_GROUPS_FILE), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function loadGroups() {
  try { return JSON.parse(fs.readFileSync(FB_GROUPS_FILE, 'utf8')); } catch { return []; }
}

function saveGroups(groups) {
  fs.writeFileSync(FB_GROUPS_FILE, JSON.stringify(groups, null, 2));
}

// Clean lock files to avoid SingletonLock conflicts
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(FB_SESSION_DIR, f)); }
  catch (e) { if (e.code !== 'ENOENT') {} }
}

(async () => {
  const options = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
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

  // Verify Facebook session
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    const url = page.url();
    if (url.includes('/login') || url.includes('login.php')) {
      console.error('[fb-join] ERROR: Facebook session not logged in — stopping');
      await browser.close();
      process.exit(1);
    }
    console.log('[fb-join] Facebook session active');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `fb-join-start-${Date.now()}.png`) });
  } catch (e) {
    console.error('[fb-join] ERROR loading Facebook:', e.message);
    await browser.close();
    process.exit(1);
  }

  const groups = loadGroups();
  const knownUrls = new Set(groups.map(g => g.group_url));
  let joinCount = 0;

  for (const keyword of FB_JOIN_KEYWORDS) {
    if (joinCount >= MAX_JOINS) break;
    console.log(`\n[fb-join] Searching for groups: "${keyword}"`);

    try {
      const searchUrl = `https://www.facebook.com/search/groups?q=${encodeURIComponent(keyword)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4000);

      // Dismiss any popups
      try {
        const closeBtn = page.locator('[aria-label="Close"], [data-testid="modal-close-button"]').first();
        if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await closeBtn.click();
          await sleep(1000);
        }
      } catch {}

      // Scroll to load more results
      for (let s = 0; s < 3; s++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await sleep(2000);
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `fb-join-search-${Date.now()}.png`) });

      // Extract group cards — Facebook renders groups as article or div with group links
      const groupCards = await page.$$eval(
        '[role="article"], div[data-testid*="group"]',
        els => els.slice(0, 20).map(el => {
          const link = el.querySelector('a[href*="/groups/"]');
          const name = el.querySelector('a[href*="/groups/"] span, h2, h3');
          const memberText = el.querySelector('span');
          return {
            url:  link ? link.href : null,
            name: name ? name.textContent.trim() : '',
            memberText: memberText ? memberText.textContent.trim() : '',
          };
        }).filter(g => g.url && g.url.includes('/groups/'))
      ).catch(() => []);

      console.log(`[fb-join] Found ${groupCards.length} group cards`);

      for (const card of groupCards) {
        if (joinCount >= MAX_JOINS) break;

        // Normalize URL — strip query params
        let groupUrl = card.url;
        try {
          const u = new URL(groupUrl);
          groupUrl = u.origin + u.pathname.replace(/\/$/, '');
        } catch {}

        if (knownUrls.has(groupUrl)) {
          console.log(`[fb-join] Already tracked: ${card.name} — skip`);
          continue;
        }

        // Parse member count from text like "1.2K members"
        const memberMatch = card.memberText.match(/([\d.,]+[KkMm]?)\s*(members|أعضاء)/i);
        const members = memberMatch ? memberMatch[1] : null;

        console.log(`[fb-join] Visiting group: ${card.name || groupUrl}`);

        try {
          await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(3000);

          // Dismiss any login prompts
          try {
            const closeBtn = page.locator('[aria-label="Close"]').first();
            if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await closeBtn.click();
              await sleep(1000);
            }
          } catch {}

          // Check current membership status
          const pageText = await page.evaluate(() => document.body?.innerText || '');
          const alreadyMember = pageText.includes('Joined') || pageText.includes('انضممت') ||
                                pageText.includes('Leave group') || pageText.includes('Write something');
          const alreadyPending = pageText.includes('Requested to join') || pageText.includes('Cancel request') ||
                                 pageText.includes('طلب انضمام');

          if (alreadyMember) {
            console.log(`[fb-join] Already a member of: ${card.name}`);
            groups.push({
              group_url: groupUrl,
              group_name: card.name,
              status: 'member',
              members,
              keyword,
              applied_at: new Date().toISOString(),
              accepted_at: new Date().toISOString(),
              last_engaged_at: null,
              posts_replied: 0,
              questions_asked: 0,
            });
            knownUrls.add(groupUrl);
            saveGroups(groups);
            continue;
          }

          if (alreadyPending) {
            console.log(`[fb-join] Already pending for: ${card.name}`);
            groups.push({
              group_url: groupUrl,
              group_name: card.name,
              status: 'pending',
              members,
              keyword,
              applied_at: new Date().toISOString(),
              accepted_at: null,
              last_engaged_at: null,
              posts_replied: 0,
              questions_asked: 0,
            });
            knownUrls.add(groupUrl);
            saveGroups(groups);
            continue;
          }

          // Try to click Join Group button
          const joinBtn = page.locator(
            'div[role="button"]:has-text("Join group"), div[role="button"]:has-text("Join Group"), ' +
            'button:has-text("Join group"), button:has-text("Join Group"), ' +
            'div[role="button"]:has-text("انضم")'
          ).first();

          const joinVisible = await joinBtn.isVisible({ timeout: 5000 }).catch(() => false);
          if (!joinVisible) {
            console.log(`[fb-join] No Join button found for: ${card.name} — skipping`);
            continue;
          }

          await joinBtn.click({ timeout: 8000 });
          await sleep(3000);

          // Check if a join question dialog appeared — dismiss it
          try {
            const submitBtn = page.locator('div[role="button"]:has-text("Submit"), button:has-text("Submit")').first();
            if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await submitBtn.click();
              await sleep(2000);
            }
          } catch {}

          await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `fb-join-applied-${Date.now()}.png`) });

          console.log(`[fb-join] ✅ Applied to join: ${card.name}`);
          groups.push({
            group_url: groupUrl,
            group_name: card.name,
            status: 'pending',
            members,
            keyword,
            applied_at: new Date().toISOString(),
            accepted_at: null,
            last_engaged_at: null,
            posts_replied: 0,
            questions_asked: 0,
          });
          knownUrls.add(groupUrl);
          saveGroups(groups);
          joinCount++;

          await sleep(rnd(5000, 10000));
        } catch (e) {
          console.error(`[fb-join] ERROR on ${card.name}: ${e.message}`);
        }
      }

    } catch (e) {
      console.error(`[fb-join] ERROR searching "${keyword}": ${e.message}`);
    }

    await sleep(rnd(5000, 10000));
  }

  await browser.close();
  console.log(`\n[fb-join] Done. Applied to ${joinCount} new groups. Total tracked: ${loadGroups().length}`);
  process.exit(0);
})();
