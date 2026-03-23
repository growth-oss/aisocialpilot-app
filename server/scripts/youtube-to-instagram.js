'use strict';
/**
 * youtube-to-instagram.js — Check each YouTube lead's username on Instagram and
 * create a matching Instagram lead if found.
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/youtube-to-instagram.js
 *
 * Required: CLIENT_ID, SESSION_DIR (Instagram session), LEADS_FILE
 * Optional: BASE_URL (default http://127.0.0.1:3000), PROXY, MAX_CHECKS (default 30), OUTREACH_LOG
 */

const { chromium } = require('playwright');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const BASE_URL    = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CLIENT_ID   = process.env.CLIENT_ID || '';
const SESSION_DIR = process.env.SESSION_DIR || '';
const LEADS_FILE  = process.env.LEADS_FILE || '';
const PROXY       = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const MAX_CHECKS  = parseInt(process.env.MAX_CHECKS || '30', 10);
const OUTREACH_LOG = process.env.OUTREACH_LOG || '';

if (!CLIENT_ID || !SESSION_DIR || !LEADS_FILE) {
  console.error('[yt2ig] ERROR: CLIENT_ID, SESSION_DIR, and LEADS_FILE are required');
  process.exit(1);
}

const delay = ms => new Promise(r => setTimeout(r, ms));
const randDelay = () => delay(3000 + Math.random() * 3000);

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
  try {
    fs.appendFileSync(OUTREACH_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  } catch {}
}

function loadLeads() {
  try {
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch (e) {
    console.error('[yt2ig] ERROR reading leads file:', e.message);
    return [];
  }
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

(async () => {
  const leads = loadLeads();

  // Filter eligible YouTube + TikTok leads to check on Instagram
  const eligible = leads.filter(l =>
    (l.platform === 'youtube' || l.platform === 'tiktok') &&
    l.engagement_stage === 0 &&
    !l.ig_checked &&
    l.username &&
    !l.username.startsWith('user-') &&
    l.username.length < 40
  );

  const toCheck = shuffle(eligible).slice(0, MAX_CHECKS);
  console.log(`[yt2ig] ${eligible.length} eligible YouTube/TikTok leads, will check up to ${MAX_CHECKS}`);

  if (toCheck.length === 0) {
    console.log('[yt2ig] Nothing to check.');
    process.exit(0);
  }

  // Build Playwright options
  const options = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  };

  if (PROXY) {
    const proxyUrl = PROXY.includes('://') ? PROXY : 'http://' + PROXY;
    const u = new URL(proxyUrl);
    options.proxy = { server: u.protocol + '//' + u.host };
    if (u.username) options.proxy.username = decodeURIComponent(u.username);
    if (u.password) options.proxy.password = decodeURIComponent(u.password);
  }

  const browser = await chromium.launchPersistentContext(SESSION_DIR, options);
  const page = browser.pages()[0] || await browser.newPage();

  // Verify Instagram session
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);
    const url = page.url();
    if (url.includes('/accounts/login') || url.includes('/login')) {
      console.error('[yt2ig] ERROR: Instagram session is not logged in — stopping');
      await browser.close();
      process.exit(1);
    }
    console.log('[yt2ig] Instagram session active');
  } catch (e) {
    console.error('[yt2ig] ERROR loading Instagram:', e.message);
    await browser.close();
    process.exit(1);
  }

  let checked = 0;
  let matched = 0;

  for (const lead of toCheck) {
    const username = lead.username;
    console.log(`\n[yt2ig] Checking @${username} on Instagram...`);

    try {
      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await delay(2000);

      const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
      const notFound = bodyText.includes("Sorry, this page isn't available") ||
                       bodyText.includes("Page Not Found");

      let profileFound = false;
      if (!notFound) {
        // Check for known profile selectors
        try {
          await page.waitForSelector('header section, main header, [data-testid="user-avatar"]', { timeout: 4000 });
          profileFound = true;
        } catch {
          // Selector not found — might still be a valid profile or might be gone
          profileFound = !notFound;
        }
      }

      if (profileFound) {
        // Try to extract follower count
        let followerCount = null;
        try {
          const followerEl = await page.$('header section ul li:first-child span');
          if (followerEl) {
            const rawFollowers = (await followerEl.textContent() || '').trim();
            followerCount = rawFollowers || null;
          }
        } catch {}

        console.log(`[yt2ig] ✅ Match found: @${username} exists on Instagram`);

        // POST new Instagram lead
        const noteSnippet = (lead.comment_text || lead.bio_snippet || '').substring(0, 100);
        try {
          await apiCall('POST', `/api/clients/${CLIENT_ID}/leadgen/leads`, {
            username:       username,
            platform:       'instagram',
            profile_url:    `https://www.instagram.com/${username}/`,
            source_type:    'youtube_cross_match',
            source_handle:  lead.source_handle || '',
            total_score:    (lead.total_score || 0) + 20,
            engagement_stage: 0,
            notes:          `Cross-matched from YouTube | original comment: ${noteSnippet}`,
            follower_count: followerCount,
          });
        } catch (apiErr) {
          console.error(`[yt2ig]   API error creating IG lead:`, apiErr.message);
        }

        logOutreach({
          platform:        'youtube_to_instagram',
          action:          'cross_match',
          target_username: username,
          status:          'match_found',
          client_id:       CLIENT_ID,
        });

        matched++;
      } else {
        console.log(`[yt2ig]   @${username} not found on Instagram`);
      }

      // Mark YouTube lead as checked
      const idx = leads.findIndex(l => l.username === username && l.platform === 'youtube');
      if (idx !== -1) {
        leads[idx].ig_checked = true;
        leads[idx].updated_at = new Date().toISOString();
      }
      saveLeads(leads);

      checked++;
    } catch (e) {
      console.error(`[yt2ig]   ERROR on @${username}:`, e.message);
    }

    if (checked < toCheck.length) {
      await randDelay();
    }
  }

  await browser.close();

  console.log(`\n[yt2ig] Summary: ${checked} checked, ${matched} matches found`);
  process.exit(0);
})();
