#!/usr/bin/env node
/**
 * facebook-group-monitor.js — Check pending group applications and update status.
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/facebook-group-monitor.js
 *
 * Required env vars:
 *   FB_SESSION_DIR  — persistent Facebook browser session path
 *   FB_GROUPS_FILE  — absolute path to facebook-groups.json
 *
 * Optional env vars:
 *   PROXY           — proxy URL (required for UAE geo)
 *   EXPIRE_DAYS     — days before marking a pending request as expired (default: 30)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const FB_SESSION_DIR  = process.env.FB_SESSION_DIR  || '';
const FB_GROUPS_FILE  = process.env.FB_GROUPS_FILE  || '';
const PROXY           = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const EXPIRE_DAYS     = parseInt(process.env.EXPIRE_DAYS || '30', 10);

if (!FB_SESSION_DIR || !FB_GROUPS_FILE) {
  console.error('[fb-monitor] ERROR: FB_SESSION_DIR and FB_GROUPS_FILE are required');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadGroups() {
  try { return JSON.parse(fs.readFileSync(FB_GROUPS_FILE, 'utf8')); } catch { return []; }
}
function saveGroups(groups) {
  fs.writeFileSync(FB_GROUPS_FILE, JSON.stringify(groups, null, 2));
}

for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(FB_SESSION_DIR, f)); } catch (e) { if (e.code !== 'ENOENT') {} }
}

(async () => {
  const groups = loadGroups();
  const pending = groups.filter(g => g.status === 'pending');

  if (!pending.length) {
    console.log('[fb-monitor] No pending group applications — nothing to check.');
    process.exit(0);
  }

  console.log(`[fb-monitor] Checking ${pending.length} pending group application(s)…`);

  const options = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled', '--disable-session-crashed-bubble'],
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
      console.error('[fb-monitor] ERROR: Facebook session not logged in — stopping');
      await browser.close();
      process.exit(1);
    }
  } catch (e) {
    console.error('[fb-monitor] ERROR loading Facebook:', e.message);
    await browser.close();
    process.exit(1);
  }

  let accepted = 0;
  let expired  = 0;

  for (const group of pending) {
    console.log(`\n[fb-monitor] Checking: ${group.group_name || group.group_url}`);

    // Check for expiry
    const daysWaiting = (Date.now() - new Date(group.applied_at).getTime()) / 86400000;
    if (daysWaiting > EXPIRE_DAYS) {
      console.log(`[fb-monitor] ⏰ Expired after ${Math.round(daysWaiting)} days: ${group.group_name}`);
      group.status = 'expired';
      expired++;
      saveGroups(groups);
      continue;
    }

    try {
      await page.goto(group.group_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3000);

      // Dismiss any popups
      try {
        const closeBtn = page.locator('[aria-label="Close"]').first();
        if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await closeBtn.click();
          await sleep(1000);
        }
      } catch {}

      const pageText = await page.evaluate(() => document.body?.innerText || '');

      // Signs we're a member: can see the feed or write box
      const isMember = pageText.includes('Write something') ||
                       pageText.includes('اكتب شيئًا') ||
                       pageText.includes('Leave group') ||
                       pageText.includes('مغادرة المجموعة') ||
                       await page.locator('[placeholder*="Write something"], [aria-label*="Write"]').isVisible({ timeout: 2000 }).catch(() => false);

      if (isMember) {
        console.log(`[fb-monitor] ✅ Accepted: ${group.group_name}`);
        group.status = 'member';
        group.accepted_at = new Date().toISOString();
        accepted++;
      } else {
        const stillPending = pageText.includes('Requested to join') ||
                             pageText.includes('Cancel request') ||
                             pageText.includes('طلب انضمام');
        console.log(`[fb-monitor] Still ${stillPending ? 'pending' : 'unknown'}: ${group.group_name} (${Math.round(daysWaiting)}d)`);
      }

      saveGroups(groups);
      await sleep(3000 + Math.random() * 3000);
    } catch (e) {
      console.error(`[fb-monitor] ERROR checking ${group.group_name}: ${e.message}`);
    }
  }

  await browser.close();
  console.log(`\n[fb-monitor] Done. Accepted: ${accepted}, Expired: ${expired}, Still pending: ${pending.length - accepted - expired}`);
  process.exit(0);
})();
