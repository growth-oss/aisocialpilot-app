#!/usr/bin/env node
/**
 * phase-c-coupons.js — Send coupon DMs to qualifying leads.
 *
 * NEVER write this script from a Claude run — it is version-controlled.
 * Claude should call it with: node /app/server/scripts/phase-c-coupons.js
 *
 * Required env vars:
 *   BASE_URL      — http://127.0.0.1:<PORT>
 *   CLIENT_ID     — client identifier
 *   SESSION_DIR   — Instagram browser session path
 *   COUPONS       — JSON array of coupon objects: [{code, label, min_lead_score, discount_pct}]
 *
 * Optional env vars:
 *   PROXY              — proxy URL
 *   MAX_DMS            — max coupon DMs to send (default: 10)
 *   COOLDOWN_HOURS     — hours between touching same lead (default: 48)
 *   DELAY_MIN          — min ms between actions (default: 4000)
 *   DELAY_MAX          — max ms between actions (default: 10000)
 *   OUTREACH_LOG       — path to outreach-log.ndjson
 *   IS_AMBASSADOR      — "1" if ambassador account mode
 *   MIN_SCORE          — minimum score to send coupon (default: 60)
 */

'use strict';

const { chromium } = require('playwright');
const fs           = require('fs');
const https        = require('https');
const http         = require('http');

// ── Env vars ──────────────────────────────────────────────────────────────────
const BASE_URL       = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CLIENT_ID      = process.env.CLIENT_ID || '';
const SESSION_DIR    = process.env.SESSION_DIR || '';
const PROXY          = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const MAX_DMS        = parseInt(process.env.MAX_DMS || '10', 10);
const COOLDOWN_HOURS = parseInt(process.env.COOLDOWN_HOURS || '48', 10);
const DELAY_MIN      = parseInt(process.env.DELAY_MIN || '4000', 10);
const DELAY_MAX      = parseInt(process.env.DELAY_MAX || '10000', 10);
const OUTREACH_LOG   = process.env.OUTREACH_LOG || '';
const IS_AMBASSADOR  = process.env.IS_AMBASSADOR === '1';
const MIN_SCORE      = parseInt(process.env.MIN_SCORE || '60', 10);
// URGENCY_MODE: when '1', send follow-up to leads who already have coupon but haven't converted
const URGENCY_MODE   = process.env.URGENCY_MODE === '1';
const URGENCY_MIN_DAYS = parseInt(process.env.URGENCY_MIN_DAYS || '7', 10);

let COUPONS = [];
try { COUPONS = JSON.parse(process.env.COUPONS || '[]'); } catch (e) { /* no coupons */ }

if (!CLIENT_ID || !SESSION_DIR) {
  console.error('[phase-c] ERROR: CLIENT_ID and SESSION_DIR are required');
  process.exit(1);
}
if (!COUPONS.length && !URGENCY_MODE) {
  console.log('[phase-c] No coupons configured and not urgency mode — skipping');
  process.exit(0);
}

// ── Coupon DM templates (5 EN + 5 AR rotating) ────────────────────────────────
// NOTE: No external URLs in DMs — Instagram spam filter flags them and risks account.
// Direct people to the Instagram bio link instead (stays within Instagram).
const BIO_HANDLE = '@bamboo_sleep_professor';

const EN_TEMPLATES = [
  (name, code) => `hey ${name}! I have a discount code I can share — ${code} — you can find the store link in my bio if you want to try the bamboo bedding 😊`,
  (name, code) => `${name}! thought of you — here's a code: ${code} — link to order is in my bio whenever you're curious 🌿`,
  (name, code) => `hi ${name}! passing this along — code ${code} — store link is in my bio, no pressure at all 🙂`,
  (name, code) => `hey ${name}! grabbed you a code — ${code} — just click the link in my bio and enter it at checkout ✨`,
  (name, code) => `${name}! random but — code ${code} — it works on the bamboo bedding, link in my bio if you want to check it out 😴`,
];
const AR_TEMPLATES = [
  (name, code) => `هلا ${name}! عندي كود خصم — ${code} — الرابط موجود في البايو تبعي لو تبين تطلبين 😊`,
  (name, code) => `${name}! فكرت فيكِ — كودك هو ${code} — رابط الطلب في البايو تبعي لو فضولك 🌿`,
  (name, code) => `هلا ${name}! أشاركك كود لو حابة: ${code} — الرابط في البايو تبعي، بدون أي ضغط 🙂`,
  (name, code) => `${name}! جبت لك كود — ${code} — تقدرين تطلبين من رابط البايو تبعي وتحطين الكود ✨`,
  (name, code) => `${name}! جاء على بالي أشاركك كود — ${code} — الرابط في البايو. يمكن يفيدك لو تحبين نوم مريح 😴`,
];

// Urgency follow-up templates (for leads who already got the coupon)
const EN_URGENCY = [
  (name) => `hey ${name}! just checking in — did you get a chance to try the discount code I sent? happy to help if you need anything 😊`,
  (name) => `${name}! wanted to make sure the code reached you okay — let me know if you have any questions before ordering 🌿`,
  (name) => `hi ${name}! following up on that discount I shared — the bamboo sheets have been so popular lately, wanted to make sure you didn't miss out ✨`,
];
const AR_URGENCY = [
  (name) => `هلا ${name}! بس أتأكد — وصلك الكود اللي أرسلته؟ قوليني لو تحتاجين أي مساعدة 😊`,
  (name) => `${name}! أبغى أتأكد وصلك الكود — قوليني لو عندك أي سؤال قبل الطلب 🌿`,
  (name) => `هلا ${name}! بس أتابع معك على الخصم — الشراشف البامبو طلبت كثير هالفترة، ما أبغاك تفوتينك الفرصة ✨`,
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randDelay = () => delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));

// Dismiss common Instagram overlays
async function dismissOverlays(page) {
  for (const sel of [
    'button:has-text("Not Now")', 'button:has-text("Not now")',
    'div[role="button"]:has-text("Not Now")',
    '[aria-label="Close"]',
    // "Which account do you want to view this as?" / profile-switch dialog
    'div[role="button"]:has-text("Continue"):not(:has-text("Continue as"))',
    'button:has-text("Continue"):not(:has-text("Continue as"))',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) { await btn.click(); await delay(800); }
    } catch {}
  }
}

// Find an existing DM thread in the inbox and send a message to it
async function sendViaExistingThread(page, lead, msg) {
  try { await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (e) { console.log(`[phase-c] inbox navigation error: ${e.message}`); return false; }
  await delay(3000);
  await dismissOverlays(page);

  // Look for existing thread in inbox thread list
  const threadSel = `[role="listitem"]:has-text("${lead.username}"), div[tabindex]:has-text("${lead.username}")`;
  let thread = page.locator(threadSel).first();
  if (!await thread.isVisible({ timeout: 4000 }).catch(() => false)) {
    // Try inbox search bar if present
    const inboxSearch = page.locator('input[placeholder*="Search" i]').first();
    if (await inboxSearch.isVisible({ timeout: 3000 }).catch(() => false)) {
      await inboxSearch.click({ force: true }).catch(() => {});
      await page.keyboard.type(lead.username, { delay: 80 });
      await delay(2000);
      thread = page.locator(threadSel).first();
    }
  }
  if (!await thread.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.log(`[phase-c] inbox: thread for @${lead.username} not visible`);
    return false;
  }
  await thread.click({ force: true }).catch(() => thread.click());
  await delay(2500);

  const inputSel = '[contenteditable="true"][role="textbox"], textarea[placeholder*="essage" i], [placeholder*="essage" i], [contenteditable="true"], div[role="textbox"]';
  const input = page.locator(inputSel).last();
  if (!await input.isVisible({ timeout: 10000 }).catch(() => false)) {
    console.log(`[phase-c] inbox: message input not found for @${lead.username} — URL: ${page.url()}`);
    return false;
  }
  await input.click({ force: true }).catch(() => input.click());
  await page.keyboard.type(msg, { delay: 55 + Math.random() * 90 });
  await delay(800);
  await page.keyboard.press('Enter');
  await delay(2000);
  return true;
}

// Send DM via compose new message flow (for contacts not yet in inbox)
async function sendCouponViaDirect(page, lead, msg) {
  try { await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (e) { console.log(`[phase-c] inbox navigation error: ${e.message}`); return false; }
  await delay(3000);
  await dismissOverlays(page);

  // Click compose button
  const composeSel = 'svg[aria-label="New message"], svg[aria-label*="New message" i], [data-testid="new-message-button"], a[href="/direct/new/"]';
  const composeBtn = page.locator(composeSel).first();
  if (await composeBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
    await composeBtn.click({ force: true }).catch(() => composeBtn.click());
    await delay(2000);
  } else {
    await page.goto('https://www.instagram.com/direct/new/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000);
  }

  const searchSel = '[role="dialog"] input, input[name="queryBox"], input[placeholder*="Search" i], [aria-label*="Search people" i], input[type="text"]';
  const searchInput = page.locator(searchSel).first();
  if (!await searchInput.isVisible({ timeout: 8000 }).catch(() => false)) {
    console.log(`[phase-c] direct: no search input — URL: ${page.url()}`);
    return false;
  }
  try {
    await searchInput.click({ force: true, timeout: 5000 });
  } catch {
    const h = await searchInput.elementHandle().catch(() => null);
    if (h) await page.evaluate(el => el.focus(), h);
    else await searchInput.focus().catch(() => {});
  }
  await page.keyboard.type(lead.username, { delay: 80 + Math.random() * 40 });
  await delay(3000);

  // Try multiple result selectors — Instagram uses different DOM structures
  const username = lead.username;
  const resultSels = [
    `[role="option"]:has-text("${username}")`,
    `[role="listitem"]:has-text("${username}")`,
    `div:has-text("${username}")[tabindex]`,
    `[tabindex]:has-text("${username}")`,
  ];
  let userResult = null;
  for (const sel of resultSels) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) { userResult = el; break; }
  }
  if (!userResult) {
    // Last resort: click first result in dropdown
    const firstResult = page.locator('[role="option"], [role="listitem"]').first();
    if (await firstResult.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`[phase-c] direct: username not matched — clicking first result for @${username}`);
      userResult = firstResult;
    } else {
      console.log(`[phase-c] direct: @${username} not found in results`);
      return false;
    }
  }
  await userResult.click({ force: true }).catch(() => userResult.click());
  await delay(1000);

  const nextBtn = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next"), div[role="button"]:has-text("Chat"), button:has-text("Chat")').first();
  if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) { await nextBtn.click({ force: true }).catch(() => nextBtn.click()); await delay(2500); }

  const inputSel = '[contenteditable="true"][role="textbox"], textarea[placeholder*="essage" i], [placeholder*="essage" i], [contenteditable="true"], div[role="textbox"]';
  const input = page.locator(inputSel).last();
  if (!await input.isVisible({ timeout: 10000 }).catch(() => false)) {
    console.log(`[phase-c] direct: input not visible for @${lead.username} — URL: ${page.url()}`);
    return false;
  }
  await input.click({ force: true }).catch(() => input.click());
  await page.keyboard.type(msg, { delay: 55 + Math.random() * 90 });
  await delay(800);
  await page.keyboard.press('Enter');
  await delay(2000);
  return true;
}

let enIdx = 0, arIdx = 0;
function getTemplate(isAr, name, code) {
  if (isAr) {
    const t = AR_TEMPLATES[arIdx % AR_TEMPLATES.length](name, code);
    arIdx++;
    return t;
  }
  const t = EN_TEMPLATES[enIdx % EN_TEMPLATES.length](name, code);
  enIdx++;
  return t;
}

function pickCoupon(score) {
  const sorted = [...COUPONS].sort((a, b) => b.min_lead_score - a.min_lead_score);
  return sorted.find(c => score >= c.min_lead_score) || sorted[sorted.length - 1];
}

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + urlPath);
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function logOutreach(entry) {
  if (!OUTREACH_LOG) return;
  try { fs.appendFileSync(OUTREACH_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'); }
  catch (e) { /* ignore */ }
}

function patchLead(username, updates) {
  return apiCall('PATCH', `/api/clients/${CLIENT_ID}/leadgen/leads/by-username`, {
    platform: 'instagram', username, ...updates, updated_at: new Date().toISOString()
  });
}

async function fetchLeads(params) {
  const qs = new URLSearchParams(params).toString();
  const result = await apiCall('GET', `/api/clients/${CLIENT_ID}/leadgen/leads?${qs}`);
  return Array.isArray(result) ? result : (result.leads || []);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[phase-c] Starting ${URGENCY_MODE ? 'urgency follow-up' : 'coupon DM'} session for ${CLIENT_ID}`);
  if (!URGENCY_MODE) console.log(`[phase-c] Coupons: ${COUPONS.map(c => c.code).join(', ')} | Max DMs: ${MAX_DMS}`);

  let leads;
  if (URGENCY_MODE) {
    // Urgency mode: target leads who already got coupon but haven't been followed up
    const allCoupon = await fetchLeads({ platform: 'instagram', coupon_referenced: 1, limit: 200 });
    const cutoff = Date.now() - URGENCY_MIN_DAYS * 86400000;
    leads = allCoupon.filter(l =>
      !l.is_converted &&
      !l.urgency_used &&
      (!l.last_engaged_at || new Date(l.last_engaged_at).getTime() < cutoff)
    ).sort((a, b) => (b.total_score || 0) - (a.total_score || 0)).slice(0, MAX_DMS);
    if (!leads.length) {
      console.log(`[phase-c] No urgency leads found (need coupon_referenced=1, urgency_used=0, last contact >${URGENCY_MIN_DAYS}d ago)`);
      process.exit(0);
    }
    console.log(`[phase-c] ${leads.length} leads eligible for urgency follow-up`);
  } else {
    // Fetch stage 5 and 6 leads without coupon (stage 5 = DM sent, stage 6 = replied/engaged)
    const [s5, s6] = await Promise.all([
      fetchLeads({ platform: 'instagram', stage: 5, coupon_referenced: 0, minScore: MIN_SCORE, limit: MAX_DMS + 5 }),
      fetchLeads({ platform: 'instagram', stage: 6, coupon_referenced: 0, minScore: MIN_SCORE, limit: MAX_DMS + 5 }),
    ]);
    // Dedupe and prioritise stage-6 first (replied), then stage-5 (DM sent)
    const seen = new Set();
    leads = [...s6, ...s5].filter(l => { if (seen.has(l.username)) return false; seen.add(l.username); return true; });
    if (!leads.length) {
      console.log('[phase-c] No qualifying leads for coupon DMs');
      process.exit(0);
    }
    console.log(`[phase-c] ${leads.length} leads eligible for coupon (stage 5: ${s5.length}, stage 6: ${s6.length})`);
  }

  // Launch browser
  const launchOpts = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  };
  if (PROXY) {
    const u = new URL(PROXY.includes('://') ? PROXY : 'http://' + PROXY);
    launchOpts.proxy = { server: u.protocol + '//' + u.host };
    if (u.username) launchOpts.proxy.username = decodeURIComponent(u.username);
    if (u.password) launchOpts.proxy.password = decodeURIComponent(u.password);
  }

  let context, page;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, launchOpts);
    page = context.pages()[0] || await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' });
  } catch (e) {
    console.error('[phase-c] Browser launch failed:', e.message);
    process.exit(1);
  }

  // Verify session active
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  if (page.url().includes('accounts/login')) {
    console.error('[phase-c] STOP: Instagram session expired — re-login via admin VNC');
    await context.close(); process.exit(1);
  }
  console.log('[phase-c] ✅ Session active');

  let sent = 0;

  for (const lead of leads) {
    if (sent >= MAX_DMS) break;

    // Check cooldown
    if (lead.last_engaged_at) {
      const hoursSince = (Date.now() - new Date(lead.last_engaged_at).getTime()) / 3600000;
      if (hoursSince < COOLDOWN_HOURS) {
        console.log(`[phase-c] Skip @${lead.username} — cooldown (${Math.round(hoursSince)}h < ${COOLDOWN_HOURS}h)`);
        continue;
      }
    }

    const name = (lead.display_name || lead.name || lead.username || '').split(' ')[0] || lead.username;
    const isAr = !!(lead.notes?.includes('Arabic') || lead.notes?.includes('arabic') || lead.bio_snippet?.match(/[ا-ي]/));

    let msg, coupon;
    if (URGENCY_MODE) {
      const urgencyTemplates = isAr ? AR_URGENCY : EN_URGENCY;
      msg = urgencyTemplates[Math.floor(Math.random() * urgencyTemplates.length)](name);
      console.log(`[phase-c] Sending urgency follow-up to @${lead.username} (score ${lead.total_score})`);
    } else {
      coupon = pickCoupon(lead.total_score || lead.lead_score || 0);
      if (!coupon) continue;
      msg = getTemplate(isAr, name, coupon.code);
      console.log(`[phase-c] Sending coupon to @${lead.username} (score ${lead.lead_score}) — ${coupon.code}`);
    }

    try {
      // Navigate to profile, wait for React to render buttons
      await page.goto(`https://www.instagram.com/${lead.username}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('header, main[role="main"], section', { timeout: 12000 }).catch(() => {});
      await delay(3000 + Math.random() * 1500);
      await dismissOverlays(page);
      await delay(1500); // wait for any dismissed overlay animation before checking buttons

      const msgBtnSel = [
        'header div[role="button"]:has-text("Message")',
        'header button:has-text("Message")',
        'div[role="button"]:has-text("Message")',
        'button:has-text("Message")',
        '[aria-label="Message"]',
      ].join(', ');
      const msgBtn = page.locator(msgBtnSel).first();
      if (!await msgBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        const btns = await page.locator('div[role="button"], button').allTextContents().catch(() => []);
        console.log(`[phase-c] No Message button for @${lead.username} — skipping (DMs restricted or not following). Visible: ${btns.slice(0,8).join(' | ')}`);
        continue;
      }
      await msgBtn.scrollIntoViewIfNeeded().catch(() => {});
      await msgBtn.click({ force: true }).catch(() => msgBtn.click());
      // Wait for navigation to /direct/ (happens when opening an existing thread or message request)
      await page.waitForURL(/direct\//, { timeout: 8000 }).catch(() => {});
      await delay(1500);

      // Handle message request confirm dialog
      const confirmBtn = page.locator('div[role="button"]:has-text("Send Message"), button:has-text("Send Message"), div[role="button"]:has-text("Send Request"), button:has-text("Send Request")').first();
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmBtn.click();
        await delay(2000);
      }

      console.log(`[phase-c] After click — URL: ${page.url().slice(0, 80)}`);

      const inputSel = '[contenteditable="true"][role="textbox"], textarea[placeholder*="essage" i], [contenteditable="true"], div[role="textbox"]';
      const msgInput = page.locator(inputSel).last();
      let dmSent = false;
      if (await msgInput.isVisible({ timeout: 10000 }).catch(() => false)) {
        await msgInput.click({ force: true }).catch(() => msgInput.click());
        await page.keyboard.type(msg, { delay: 55 + Math.random() * 90 });
        await delay(700);
        await page.keyboard.press('Enter');
        await delay(2000);
        dmSent = true;
      } else {
        const elems = await page.locator('div[role="button"], [placeholder]').allTextContents().catch(() => []);
        console.log(`[phase-c] Profile DM failed for @${lead.username} — trying inbox thread | Elements: ${elems.slice(0,5).join(' | ')}`);
        dmSent = await sendViaExistingThread(page, lead, msg);
        if (!dmSent) dmSent = await sendCouponViaDirect(page, lead, msg);
      }

      if (!dmSent) { console.log(`[phase-c] Both DM methods failed for @${lead.username} — skipping`); continue; }

      sent++;
      if (URGENCY_MODE) {
        console.log(`[phase-c] ✅ Urgency follow-up sent to @${lead.username}`);
        await patchLead(lead.username, { urgency_used: 1, last_engaged_at: new Date().toISOString() });
        logOutreach({ action_type: 'urgency_dm', platform: 'instagram', username: lead.username, content_used: msg, result: 'sent' });
      } else {
        console.log(`[phase-c] ✅ Coupon DM sent to @${lead.username}: code=${coupon.code}`);
        await patchLead(lead.username, {
          coupon_referenced: 1,
          coupon_code: coupon.code,
          last_engaged_at: new Date().toISOString()
        });
        logOutreach({ action_type: 'coupon_dm', platform: 'instagram', username: lead.username, coupon_code: coupon.code, content_used: msg, result: 'sent' });
      }

      await randDelay();
      await delay(20000 + Math.random() * 30000); // 20-50s between coupon DMs

    } catch (err) {
      console.error(`[phase-c] Error for @${lead.username}:`, err.message);
      // Stop any pending navigation (cancels chrome-error:// or stuck pages)
      // then wait for the page to go idle before the next lead
      try { await page.evaluate('window.stop()'); } catch {}
      await delay(3000);
    }
  }

  await context.close();
  console.log(`[phase-c] Done. Sent ${sent} ${URGENCY_MODE ? 'urgency follow-up' : 'coupon'} DMs`);
})();
