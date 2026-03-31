#!/usr/bin/env node
/**
 * facebook-to-instagram.js — Cross-match Facebook leads to Instagram profiles.
 *
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/facebook-to-instagram.js
 *
 * Strategy:
 *   1. For Facebook leads with a real username (not uid_*):
 *      → Try instagram.com/<username> directly first
 *   2. For uid_* leads with a display_name:
 *      → Search Instagram for the display name, pick the first plausible match
 *   3. When matched: create a new Instagram lead (stage 0) linked to the Facebook source
 *   4. Mark the Facebook lead as ig_checked=true regardless of outcome
 *
 * Required env vars:
 *   CLIENT_ID     — client identifier
 *   SESSION_DIR   — Instagram browser session path
 *   LEADS_FILE    — absolute path to leads.json
 *
 * Optional env vars:
 *   BASE_URL       — http://127.0.0.1:<PORT> (default http://127.0.0.1:3000)
 *   PROXY          — proxy URL
 *   OUTREACH_LOG   — path to outreach-log.ndjson
 *   MAX_CHECKS     — max Facebook leads to process per run (default: 40)
 */
'use strict';

const { chromium } = require('playwright');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const BASE_URL     = process.env.BASE_URL    || 'http://127.0.0.1:3000';
const CLIENT_ID    = process.env.CLIENT_ID   || '';
const SESSION_DIR  = process.env.SESSION_DIR || '';
const LEADS_FILE   = process.env.LEADS_FILE  || '';
const PROXY        = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const MAX_CHECKS   = parseInt(process.env.MAX_CHECKS || '40', 10);
const OUTREACH_LOG = process.env.OUTREACH_LOG || '';

if (!CLIENT_ID || !SESSION_DIR || !LEADS_FILE) {
  console.error('[fb2ig] ERROR: CLIENT_ID, SESSION_DIR, and LEADS_FILE are required');
  process.exit(1);
}

const delay    = ms => new Promise(r => setTimeout(r, ms));
const randDelay = () => delay(3000 + Math.random() * 4000);

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + urlPath);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = lib.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function logOutreach(entry) {
  if (!OUTREACH_LOG) return;
  try { fs.appendFileSync(OUTREACH_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'); } catch {}
}

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch { return []; }
}

function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Dismiss overlays
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

// Check if a direct instagram.com/<username> exists and return profile info
async function checkDirectUsername(page, username) {
  try {
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await delay(2000);
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const notFound = bodyText.includes("Sorry, this page isn't available") ||
                     bodyText.includes("Page Not Found");
    if (notFound) return null;

    // Try to get follower count and bio
    let followerCount = null, bio = null, displayName = null;
    try {
      const metaDesc = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');
      // Instagram meta: "123 Followers, 45 Following, 67 Posts - Name (@handle) on Instagram: "bio""
      const followerMatch = metaDesc.match(/([\d,KkMm.]+)\s*Followers?/i);
      if (followerMatch) followerCount = followerMatch[1];
      const nameMatch = metaDesc.match(/^.*?- (.+?) \(@/);
      if (nameMatch) displayName = nameMatch[1].trim();
      const bioMatch = metaDesc.match(/on Instagram: "(.+?)"/s);
      if (bioMatch) bio = bioMatch[1].slice(0, 150);
    } catch {}

    return { username, followerCount, bio, displayName };
  } catch {
    return null;
  }
}

// Search Instagram for a display name and return the best match username
async function searchInstagramByName(page, displayName) {
  if (!displayName || displayName.length < 3) return null;

  // Use Instagram's search
  const searchUrl = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(displayName)}`;
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(2500);
    await dismissOverlays(page);
  } catch (e) {
    // Fallback: use the search bar
    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await delay(2000);
      const searchInput = page.locator('[placeholder*="Search" i], [aria-label*="Search" i]').first();
      if (await searchInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await searchInput.click();
        await page.keyboard.type(displayName, { delay: 80 });
        await delay(2500);
      }
    } catch {}
  }

  // Extract result usernames from the search results page
  const results = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(
      '[role="option"] a, [role="listitem"] a, a[href*="/"][tabindex]'
    ));
    const seen = new Set();
    return items.map(a => {
      const href = a.href || '';
      const m = href.match(/instagram\.com\/([^/?#]+)/);
      const username = m ? m[1] : null;
      const text = (a.innerText || '').trim();
      return { username, text, href };
    }).filter(r => {
      if (!r.username) return false;
      const skip = ['explore', 'accounts', 'reels', 'stories', 'p', 'direct', 'tv', 'reel'];
      if (skip.includes(r.username.toLowerCase())) return false;
      if (seen.has(r.username)) return false;
      seen.add(r.username);
      return true;
    });
  }).catch(() => []);

  if (!results.length) return null;

  // Score candidates: prefer results where the display text matches the FB display name
  const nameLower = displayName.toLowerCase();
  const nameParts = nameLower.split(/\s+/).filter(p => p.length > 1);

  let best = null, bestScore = -1;
  for (const r of results.slice(0, 8)) {
    const textLower = r.text.toLowerCase();
    let score = 0;
    for (const part of nameParts) {
      if (textLower.includes(part)) score += 2;
      if (r.username.toLowerCase().includes(part)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }

  // Require at least one name part to match to avoid false positives
  if (!best || bestScore < 1) return null;

  console.log(`[fb2ig] Name search "${displayName}" → best match: @${best.username} (score ${bestScore})`);
  return best.username;
}

(async () => {
  console.log(`[fb2ig] Starting Facebook→Instagram cross-match for ${CLIENT_ID}`);

  const leads = loadLeads();

  // Build set of existing Instagram usernames to avoid duplicates
  const igUsernames = new Set(
    leads.filter(l => l.platform === 'instagram').map(l => l.username?.toLowerCase()).filter(Boolean)
  );

  // Eligible: Facebook stage-0 leads not yet ig_checked
  const fbLeads = leads.filter(l =>
    l.platform === 'facebook' &&
    l.engagement_stage === 0 &&
    !l.ig_checked &&
    (l.username || l.display_name)
  );

  // Prioritise: uid_* leads (have no direct username) last; real-username leads first
  const uidLeads  = fbLeads.filter(l => l.username?.startsWith('uid_'));
  const realLeads = fbLeads.filter(l => l.username && !l.username.startsWith('uid_'));
  const toCheck   = shuffle([...realLeads, ...uidLeads]).slice(0, MAX_CHECKS);

  console.log(`[fb2ig] ${fbLeads.length} eligible FB leads (${realLeads.length} real username, ${uidLeads.length} uid_*), checking up to ${MAX_CHECKS}`);

  if (!toCheck.length) {
    console.log('[fb2ig] Nothing to check — all Facebook leads already ig_checked');
    process.exit(0);
  }

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

  // Clear stale SingletonLock before launch
  const lockFile = path.join(SESSION_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    try { fs.unlinkSync(lockFile); console.log('[fb2ig] Removed stale SingletonLock'); } catch {}
  }

  let context, page;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, launchOpts);
    page = context.pages()[0] || await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' });
  } catch (e) {
    console.error('[fb2ig] Browser launch failed:', e.message);
    process.exit(1);
  }

  // Verify Instagram session
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);
    if (page.url().includes('/accounts/login') || page.url().includes('/login')) {
      console.error('[fb2ig] ERROR: Instagram session not logged in — stopping');
      await context.close();
      process.exit(1);
    }
    console.log('[fb2ig] ✅ Instagram session active');
  } catch (e) {
    console.error('[fb2ig] ERROR loading Instagram:', e.message);
    await context.close();
    process.exit(1);
  }

  let checked = 0, matched = 0;

  for (const fbLead of toCheck) {
    const isUid = fbLead.username?.startsWith('uid_');
    const displayName = fbLead.display_name || fbLead.name || '';

    console.log(`\n[fb2ig] [${checked + 1}/${toCheck.length}] FB: @${fbLead.username} "${displayName}" (uid: ${isUid})`);

    let igUsername = null;
    let matchMethod = null;

    try {
      if (!isUid && fbLead.username) {
        // Strategy 1: direct username lookup
        console.log(`[fb2ig]   → trying direct: instagram.com/${fbLead.username}`);
        const profile = await checkDirectUsername(page, fbLead.username);
        if (profile) {
          igUsername = profile.username;
          matchMethod = 'direct_username';
          console.log(`[fb2ig]   ✅ Direct match: @${igUsername}`);
        } else {
          console.log(`[fb2ig]   → direct lookup: not found`);
        }
      }

      if (!igUsername && displayName && displayName.length >= 3) {
        // Strategy 2: search by display name
        console.log(`[fb2ig]   → searching by name: "${displayName}"`);
        igUsername = await searchInstagramByName(page, displayName);
        if (igUsername) matchMethod = 'name_search';
      }

      if (igUsername) {
        const igLower = igUsername.toLowerCase();
        if (igUsernames.has(igLower)) {
          console.log(`[fb2ig]   ⚠️  @${igUsername} already in pipeline — skipping duplicate`);
        } else {
          igUsernames.add(igLower);
          matched++;

          // Create Instagram lead via API
          const score = (fbLead.total_score || 40) + 20;
          const note = `Cross-matched from Facebook (${matchMethod}) | FB: ${fbLead.username} | name: ${displayName}`;
          try {
            await apiCall('POST', `/api/clients/${CLIENT_ID}/leadgen/leads`, {
              username:         igUsername,
              platform:         'instagram',
              profile_url:      `https://www.instagram.com/${igUsername}/`,
              source_type:      'facebook_cross_match',
              source_handle:    fbLead.source_handle || '',
              total_score:      score,
              engagement_stage: 0,
              notes:            note,
              display_name:     displayName || undefined,
            });
            console.log(`[fb2ig]   ✅ Created IG lead @${igUsername} (score ${score})`);
          } catch (apiErr) {
            console.error(`[fb2ig]   API error:`, apiErr.message);
          }

          logOutreach({
            action_type:      'facebook_to_instagram_match',
            platform:         'instagram',
            username:         igUsername,
            fb_username:      fbLead.username,
            display_name:     displayName,
            match_method:     matchMethod,
            result:           'match_found',
            client_id:        CLIENT_ID,
          });
        }
      } else {
        console.log(`[fb2ig]   ✗ No Instagram match found for "${displayName || fbLead.username}"`);
        logOutreach({
          action_type:  'facebook_to_instagram_match',
          platform:     'instagram',
          fb_username:  fbLead.username,
          display_name: displayName,
          result:       'no_match',
          client_id:    CLIENT_ID,
        });
      }

      // Mark Facebook lead as ig_checked regardless of outcome
      const idx = leads.findIndex(l => l.platform === 'facebook' && l.username === fbLead.username);
      if (idx !== -1) {
        leads[idx].ig_checked = true;
        leads[idx].ig_match = igUsername || null;
        leads[idx].updated_at = new Date().toISOString();
      }
      saveLeads(leads);
      checked++;

    } catch (e) {
      console.error(`[fb2ig]   ERROR for ${fbLead.username}:`, e.message);
      try { await page.evaluate('window.stop()'); } catch {}
      await delay(3000);
    }

    if (checked < toCheck.length) await randDelay();
  }

  await context.close();

  console.log(`\n[fb2ig] ═══ CROSS-MATCH SUMMARY ═══`);
  console.log(`[fb2ig] Checked:  ${checked}`);
  console.log(`[fb2ig] Matched:  ${matched} new Instagram leads created`);
  console.log(`[fb2ig] ════════════════════════════`);
})();
