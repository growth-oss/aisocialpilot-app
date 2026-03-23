#!/usr/bin/env node
/**
 * phase-b-pipeline.js — Instagram pipeline advancement (comments + DMs).
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/phase-b-pipeline.js
 *
 * Required: BASE_URL, CLIENT_ID, SESSION_DIR
 * Optional: PROXY, MAX_LEADS, MAX_DMS, MAX_COMMENTS, COOLDOWN_HOURS,
 *           DM_FOLLOWBACK_DAYS, DELAY_MIN, DELAY_MAX, OUTREACH_LOG,
 *           DM_SCORE_THRESHOLD, COMMENT_SCORE_THRESHOLD, IS_AMBASSADOR
 */
'use strict';

const { chromium } = require('playwright');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const BASE_URL           = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CLIENT_ID          = process.env.CLIENT_ID || '';
const SESSION_DIR        = process.env.SESSION_DIR || '';
const PROXY              = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const MAX_LEADS          = parseInt(process.env.MAX_LEADS  || '20', 10);
const MAX_DMS            = parseInt(process.env.MAX_DMS    || '8',  10);
const MAX_COMMENTS       = parseInt(process.env.MAX_COMMENTS || '10', 10);
const COOLDOWN_HOURS     = parseInt(process.env.COOLDOWN_HOURS || '0', 10);
const DM_FOLLOWBACK_DAYS = parseInt(process.env.DM_FOLLOWBACK_DAYS || '1', 10);
const DELAY_MIN          = parseInt(process.env.DELAY_MIN  || '3000', 10);
const DELAY_MAX          = parseInt(process.env.DELAY_MAX  || '8000', 10);
const OUTREACH_LOG       = process.env.OUTREACH_LOG || '';
const DM_SCORE           = parseInt(process.env.DM_SCORE_THRESHOLD     || '50', 10);
const COMMENT_SCORE      = parseInt(process.env.COMMENT_SCORE_THRESHOLD || '40', 10);
const IS_AMBASSADOR      = process.env.IS_AMBASSADOR === '1';

if (!CLIENT_ID || !SESSION_DIR) {
  console.error('[phase-b] ERROR: CLIENT_ID and SESSION_DIR required'); process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay       = ms => new Promise(r => setTimeout(r, ms));
const randAction  = () => delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
const randProfile = () => delay(8000 + Math.random() * 12000);

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + urlPath);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json' } };
    const req = lib.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function patchLead(username, updates) {
  return apiCall('PATCH', `/api/clients/${CLIENT_ID}/leadgen/leads/by-username`, { username, ...updates, updated_at: new Date().toISOString() });
}

async function fetchLeads(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await apiCall('GET', `/api/clients/${CLIENT_ID}/leadgen/leads?${qs}`);
  return Array.isArray(r) ? r : (r.leads || []);
}

function logOutreach(entry) {
  if (!OUTREACH_LOG) return;
  try { fs.appendFileSync(OUTREACH_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'); } catch {}
}

function getScore(lead)  { return lead.total_score || lead.lead_score || 0; }
function getName(lead)   { return (lead.display_name || lead.name || lead.username || '').split(' ')[0] || lead.username; }
function isArabic(lead)  { return /[ا-ي]/.test(lead.bio_snippet || '') || (lead.notes || '').includes('arabic') || (lead.notes || '').includes('Arabic'); }

function isOnCooldown(lead) {
  if (!lead.last_engaged_at || COOLDOWN_HOURS === 0) return false;
  return (Date.now() - new Date(lead.last_engaged_at).getTime()) / 3600000 < COOLDOWN_HOURS;
}
function followbackReady(lead) {
  if (!lead.last_engaged_at) return true;
  return (Date.now() - new Date(lead.last_engaged_at).getTime()) / 86400000 >= DM_FOLLOWBACK_DAYS;
}

// ── Message / comment pools ───────────────────────────────────────────────────
const EN_DM = [
  (n, s) => `hey ${n}! noticed you follow ${s} — looks like we have similar taste 😊 do you have a favourite bedding brand?`,
  (n, s) => `hi ${n}! saw you follow ${s} — curious if you're into natural fabrics? I've been obsessed lately`,
  (n)    => `hey ${n}! random but I love your taste — are you into bamboo bedding at all? been a game changer for me`,
  (n)    => `hi ${n}! I follow a lot of the same sleep accounts as you 😄 are you based in the UAE by any chance?`,
  (n)    => `hey ${n}! just came across your profile — do you have any bedding recommendations? always looking for new options`,
  (n)    => `hi ${n}! love what you share 🌿 have you ever tried bamboo sheets? genuinely curious what your sleep setup is like`,
  (n)    => `hey ${n}! noticed we follow similar accounts — are you into the whole natural living / sleep quality thing?`,
];
const AR_DM = [
  (n, s) => `هلا ${n}! شفت إنك تتابعين ${s} — يبدو عندنا نفس الذوق 😊 عندك ماركة مفارش تحبينها؟`,
  (n, s) => `هلا ${n}! لاحظت إنك تتابعين ${s} — هل تهتمين بالأقمشة الطبيعية؟ أنا منبهرة بها هالفترة`,
  (n)    => `هلا ${n}! بصراحة أحب ذوقك — هل جربتِ مفارش البامبو؟ غيّرت حياتي فعلاً`,
  (n)    => `هلا ${n}! أنا أتابع نفس حسابات النوم اللي تتابعينها 😄 هل أنتِ بالإمارات؟`,
  (n)    => `هلا ${n}! وقعت على حسابك — عندك توصيات لمفارش؟ دايم أبحث عن خيارات جديدة`,
  (n)    => `هلا ${n}! أحب ما تشاركينه 🌿 جربتِ مفارش البامبو؟ فضولي أعرف كيف جهازك للنوم`,
  (n)    => `هلا ${n}! لاحظت نتابع نفس الحسابات — مهتمة بموضوع العيش الطبيعي وجودة النوم؟`,
];

const EN_COMMENTS = ['love this ✨','such a beautiful space 🌿','this is so inspiring 😍','obsessed with this aesthetic 💚','gorgeous 😍','so dreamy ✨','this is everything 🙏'];
const AR_COMMENTS = ['محتوى رائع! 😍','أسلوبك يعجبني 🌿','مشاركة جميلة! ✨','هذا المحتوى مفيد جداً 🙏','واو، رائع جداً 😍','أحب هذا الستايل 💚'];

function getDMMsg(lead) {
  const n    = getName(lead);
  const src  = lead.source_handle ? `@${lead.source_handle.replace('@','')}` : 'sleep content';
  const pool = isArabic(lead) ? AR_DM : EN_DM;
  const fn   = pool[Math.floor(Math.random() * pool.length)];
  return fn(n, src);
}
function getCommentText(lead) {
  const pool = isArabic(lead) ? AR_COMMENTS : EN_COMMENTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Instagram actions ─────────────────────────────────────────────────────────

// Fallback: send DM via /direct/new/ search flow (bypasses profile Message button)
async function sendDMViaDirect(page, lead) {
  await page.goto('https://www.instagram.com/direct/new/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(2500);

  const searchInput = page.locator('input[name="queryBox"], input[placeholder*="Search" i], [aria-label*="Search" i]').first();
  if (!await searchInput.isVisible({ timeout: 6000 }).catch(() => false)) {
    console.log(`[phase-b] direct/new: no search input — URL: ${page.url()}`);
    return false;
  }
  await searchInput.click();
  await page.keyboard.type(lead.username, { delay: 80 + Math.random() * 40 });
  await delay(2000);

  const userResult = page.locator(`[role="option"]:has-text("${lead.username}"), [role="listitem"]:has-text("${lead.username}")`).first();
  if (!await userResult.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log(`[phase-b] direct/new: @${lead.username} not found in search results`);
    return false;
  }
  await userResult.click();
  await delay(1000);

  const nextBtn = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next"), div[role="button"]:has-text("Chat")').first();
  if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nextBtn.click();
    await delay(2000);
  }

  const inputSel = '[contenteditable="true"][role="textbox"], textarea[placeholder*="essage" i], [contenteditable="true"], div[role="textbox"]';
  const input = page.locator(inputSel).last();
  if (!await input.isVisible({ timeout: 8000 }).catch(() => false)) {
    console.log(`[phase-b] direct/new: message input not visible for @${lead.username}`);
    return false;
  }

  const msg = getDMMsg(lead);
  await input.click();
  await page.keyboard.type(msg, { delay: 55 + Math.random() * 75 });
  await delay(800);
  await page.keyboard.press('Enter');
  await delay(2000);

  console.log(`[phase-b] ✅ DM (direct) → @${lead.username}: "${msg.slice(0,70)}..."`);
  await patchLead(lead.username, { engagement_stage: 5, last_engaged_at: new Date().toISOString() });
  logOutreach({ action_type: 'dm', platform: 'instagram', username: lead.username, content_used: msg, result: 'sent' });
  return true;
}

async function sendDM(page, lead) {
  const profileUrl = `https://www.instagram.com/${lead.username}/`;
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(2000 + Math.random() * 2000);

  // Use Message button on profile
  const msgBtnSelector = [
    'div[role="button"]:has-text("Message")',
    'button:has-text("Message")',
    'a:has-text("Message")',
    '[aria-label="Message"]',
    'div[tabindex="0"]:has-text("Message")',
  ].join(', ');
  const msgBtn = page.locator(msgBtnSelector).first();

  // Debug: log all buttons visible on the page if Message not found
  if (!await msgBtn.isVisible({ timeout: 7000 }).catch(() => false)) {
    const btns = await page.locator('div[role="button"], button').allTextContents().catch(() => []);
    console.log(`[phase-b] No Message button for @${lead.username}. Visible buttons: ${btns.slice(0,8).join(' | ')}`);
    return false;
  }
  await msgBtn.click();
  await delay(3500);

  // Handle Instagram message request confirmation dialog (appears for non-mutual followers)
  const confirmBtn = page.locator('div[role="button"]:has-text("Send Message"), button:has-text("Send Message"), div[role="button"]:has-text("Send Request"), button:has-text("Send Request")').first();
  if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log(`[phase-b] Clicking message request confirm for @${lead.username}`);
    await confirmBtn.click();
    await delay(2000);
  }

  // Log current URL and page title for debugging
  console.log(`[phase-b] After Message click — URL: ${page.url().slice(0, 80)}`);

  // Broad input selector covering regular DM, message request, and mobile-style views
  const inputSel = [
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="essage" i]',
    'textarea[placeholder*="esage" i]',
    '[contenteditable="true"]',
    'div[role="textbox"]',
  ].join(', ');
  const input = page.locator(inputSel).last();
  if (!await input.isVisible({ timeout: 10000 }).catch(() => false)) {
    const url = page.url();
    const allText = await page.locator('div[role="button"], button, [placeholder]').allTextContents().catch(() => []);
    console.log(`[phase-b] Profile DM failed for @${lead.username} — URL: ${url.slice(0,80)} | Elements: ${allText.slice(0,6).join(' | ')}`);
    console.log(`[phase-b] Falling back to direct/new for @${lead.username}`);
    return sendDMViaDirect(page, lead);
  }

  const msg = getDMMsg(lead);
  await input.click();
  await page.keyboard.type(msg, { delay: 55 + Math.random() * 75 });
  await delay(800);
  await page.keyboard.press('Enter');
  await delay(2000);

  console.log(`[phase-b] ✅ DM → @${lead.username}: "${msg.slice(0,70)}..."`);
  await patchLead(lead.username, { engagement_stage: 5, last_engaged_at: new Date().toISOString() });
  logOutreach({ action_type: 'dm', platform: 'instagram', username: lead.username, content_used: msg, result: 'sent' });
  return true;
}

async function leaveComment(page, lead) {
  const profileUrl = `https://www.instagram.com/${lead.username}/`;
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(2000 + Math.random() * 2000);

  const post = page.locator('a[href*="/p/"], a[href*="/reel/"]').first();
  if (!await post.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log(`[phase-b] No posts for @${lead.username}`);
    return false;
  }
  await post.click();
  await delay(2500);

  const box = page.locator('[aria-label="Add a comment…"], [placeholder="Add a comment…"], textarea[placeholder*="comment" i]').first();
  if (!await box.isVisible({ timeout: 7000 }).catch(() => false)) {
    console.log(`[phase-b] Comment box not visible for @${lead.username}`);
    return false;
  }

  const text = getCommentText(lead);
  await box.click();
  await page.keyboard.type(text, { delay: 60 + Math.random() * 80 });
  await delay(700);
  await page.keyboard.press('Enter');
  await delay(2000);

  console.log(`[phase-b] ✅ Comment → @${lead.username}: "${text}"`);
  await patchLead(lead.username, { engagement_stage: 4, last_engaged_at: new Date().toISOString() });
  logOutreach({ action_type: 'comment', platform: 'instagram', username: lead.username, content_used: text, result: 'posted' });
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[phase-b] Starting — DM threshold: ${DM_SCORE} | Comment threshold: ${COMMENT_SCORE}`);

  const launchOpts = { headless: false, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'] };
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
  } catch (e) { console.error('[phase-b] Launch failed:', e.message); process.exit(1); }

  // Verify session
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000);
  if (page.url().includes('accounts/login')) {
    console.error('[phase-b] STOP: Instagram session expired — re-login via admin VNC');
    await context.close(); process.exit(1);
  }
  console.log('[phase-b] ✅ Session active');

  let dms = 0, comments = 0, processed = 0;

  const stage3 = await fetchLeads({ platform: 'instagram', stage: 3, limit: MAX_LEADS });
  const stage4 = await fetchLeads({ platform: 'instagram', stage: 4, minScore: DM_SCORE, limit: 10 });
  const leads  = [...stage3, ...stage4];
  console.log(`[phase-b] ${stage3.length} stage-3, ${stage4.length} stage-4 leads to process`);

  for (const lead of leads) {
    if (processed >= MAX_LEADS || (dms >= MAX_DMS && comments >= MAX_COMMENTS)) break;
    if (isOnCooldown(lead)) { console.log(`[phase-b] Skip @${lead.username} cooldown`); continue; }

    const score = getScore(lead);
    console.log(`[phase-b] @${lead.username} stage=${lead.engagement_stage} score=${score} followbackReady=${followbackReady(lead)}`);

    try {
      if (lead.engagement_stage >= 4 && dms < MAX_DMS && followbackReady(lead)) {
        // Already commented — send DM
        await sendDM(page, lead);
        dms++;
      } else if (lead.engagement_stage === 3 && score >= DM_SCORE && dms < MAX_DMS && followbackReady(lead)) {
        // High score + followback ready → DM directly
        const sent = await sendDM(page, lead);
        if (sent) dms++;
        else if (score >= COMMENT_SCORE && comments < MAX_COMMENTS) {
          // Message button absent → comment instead
          const done = await leaveComment(page, lead);
          if (done) comments++;
        }
      } else if (lead.engagement_stage === 3 && score >= COMMENT_SCORE && comments < MAX_COMMENTS) {
        // Mid score → comment to advance to stage 4
        const done = await leaveComment(page, lead);
        if (done) comments++;
      } else {
        console.log(`[phase-b] @${lead.username} score ${score} too low or limits hit — skip`);
      }

      processed++;
      await randProfile();
    } catch (err) {
      console.error(`[phase-b] Error @${lead.username}:`, err.message);
    }
  }

  await context.close();
  console.log(`[phase-b] Done — processed: ${processed} | DMs: ${dms} | Comments: ${comments}`);
})();
