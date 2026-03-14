#!/usr/bin/env node
/**
 * post-via-blotato.js — Post to Instagram via Blotato REST API.
 *
 * Replaces the Playwright browser-automation posting step with a reliable
 * API call. Playwright is still used ONLY for the DM step (if DM_LEADS is set).
 *
 * Required env vars:
 *   BLOTATO_API_KEY      — from Blotato Settings → API
 *   BLOTATO_ACCOUNT_ID   — from GET /v2/users/me/accounts (Instagram account ID)
 *   BRIEF_ID             — brief identifier
 *   BRIEFS_FILE          — absolute path to precision-briefs.json
 *   FORMAT               — carousel | post | story | dm_only
 *
 * Optional env vars:
 *   CAPTION              — post caption text
 *   CAROUSEL_IMAGES      — JSON array of CDN image URLs (product_carousel)
 *   IMAGE_URL            — publicly accessible URL of the image (standard briefs)
 *   DM_LEADS             — JSON array of {username, message} to DM after posting
 *   SESSION_DIR          — browser session dir (needed only if DM_LEADS is set)
 *   PROXY_URL            — proxy for DM Playwright session
 *   EXPECTED_GEO         — country code to verify before DMs
 *   LEADS_FILE           — path to leads.json (stage updates after DM)
 *   OUTREACH_LOG         — path to outreach-log.ndjson
 *   SCREENSHOTS_DIR      — where to save DM screenshots
 *   INSTAGRAM_HANDLE     — account handle (used for DM session)
 */

'use strict';

const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

// ── Read env vars ─────────────────────────────────────────────────────────────
const BLOTATO_API_KEY    = process.env.BLOTATO_API_KEY;
const BLOTATO_ACCOUNT_ID = process.env.BLOTATO_ACCOUNT_ID;
const BRIEF_ID           = process.env.BRIEF_ID;
const BRIEFS_FILE        = process.env.BRIEFS_FILE;
const FORMAT             = process.env.FORMAT || 'carousel';
const CAPTION            = process.env.CAPTION || '';
const CAROUSEL_IMAGES    = JSON.parse(process.env.CAROUSEL_IMAGES || '[]');
const IMAGE_URL          = process.env.IMAGE_URL || '';
const DM_LEADS           = JSON.parse(process.env.DM_LEADS || '[]');
const SESSION_DIR        = process.env.SESSION_DIR || '';
const PROXY_URL          = process.env.PROXY_URL || '';
const EXPECTED_GEO       = process.env.EXPECTED_GEO || '';
const LEADS_FILE         = process.env.LEADS_FILE || '';
const OUTREACH_LOG       = process.env.OUTREACH_LOG || '';
const SCREENSHOTS_DIR    = process.env.SCREENSHOTS_DIR || '/tmp';
const HANDLE             = (process.env.INSTAGRAM_HANDLE || '').replace(/^@/, '');

if (!BLOTATO_API_KEY || !BLOTATO_ACCOUNT_ID) {
  console.error('[fatal] Missing BLOTATO_API_KEY or BLOTATO_ACCOUNT_ID');
  process.exit(1);
}
if (!BRIEF_ID || !BRIEFS_FILE) {
  console.error('[fatal] Missing BRIEF_ID or BRIEFS_FILE');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag, ...args) {
  console.log(`[${tag}]`, ...args);
}

function updateBrief(fields) {
  try {
    const briefs = JSON.parse(fs.readFileSync(BRIEFS_FILE, 'utf8'));
    const idx = briefs.findIndex(b => b.brief_id === BRIEF_ID);
    if (idx === -1) { log('brief', 'ERROR: brief not found:', BRIEF_ID); return; }
    Object.assign(briefs[idx], fields, { updated_at: new Date().toISOString() });
    fs.writeFileSync(BRIEFS_FILE, JSON.stringify(briefs, null, 2));
    log('brief', 'Updated', BRIEF_ID, JSON.stringify(fields));
  } catch (e) {
    log('brief', 'ERROR updating brief:', e.message);
  }
}

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'backend.blotato.com',
      port: 443,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'blotato-api-key': BLOTATO_API_KEY,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let postUrl = null;
  let dmsSent = 0;

  try {
    // ── 1. dm_only: skip posting ─────────────────────────────────────────────
    if (FORMAT === 'dm_only') {
      log('post', 'Format is dm_only — skipping Instagram post, going straight to DMs');
    } else {
      // ── 2. Resolve media URLs ──────────────────────────────────────────────
      let mediaUrls = [];

      if (CAROUSEL_IMAGES.length) {
        mediaUrls = CAROUSEL_IMAGES;
        log('post', `Using ${mediaUrls.length} carousel CDN image(s)`);
      } else if (IMAGE_URL) {
        mediaUrls = [IMAGE_URL];
        log('post', `Using image URL: ${IMAGE_URL}`);
      } else {
        log('post', 'ERROR: No CAROUSEL_IMAGES or IMAGE_URL provided');
        updateBrief({ status: 'failed', error: 'no_image_url' });
        process.exit(1);
      }

      // ── 3. Post via Blotato API ────────────────────────────────────────────
      log('post', `Posting to Instagram via Blotato (account: ${BLOTATO_ACCOUNT_ID})…`);
      log('post', `Media URLs: ${mediaUrls.join(', ')}`);

      const payload = {
        post: {
          accountId: BLOTATO_ACCOUNT_ID,
          content: {
            text: CAPTION,
            mediaUrls,
            platform: 'instagram',
          },
          target: {
            targetType: 'instagram',
          },
        },
      };

      const result = await apiPost('/v2/posts', payload);
      log('post', `Blotato response (${result.status}):`, JSON.stringify(result.body));

      if (result.status !== 200 && result.status !== 201) {
        const errMsg = (typeof result.body === 'object' ? JSON.stringify(result.body) : result.body) || 'Unknown error';
        updateBrief({ status: 'failed', error: `blotato_${result.status}: ${errMsg}` });
        process.exit(1);
      }

      // Extract post URL from response
      postUrl = result.body?.post?.url ||
                result.body?.url ||
                result.body?.data?.url ||
                result.body?.postUrl ||
                null;

      log('post', 'Post published ✓', postUrl ? `URL: ${postUrl}` : '(URL not returned by Blotato)');
    }

    // ── 4. DM step (Playwright) ───────────────────────────────────────────────
    if (DM_LEADS.length > 0 && SESSION_DIR) {
      log('dm', `Sending DMs to ${DM_LEADS.length} lead(s) via Playwright…`);

      // Geo check before opening session
      if (PROXY_URL && EXPECTED_GEO) {
        try {
          const out = execSync(
            `curl -s -x '${PROXY_URL}' --max-time 20 --connect-timeout 15 https://ipinfo.io/json`,
            { encoding: 'utf8', timeout: 25000 }
          );
          const info = JSON.parse(out);
          if (info.country !== EXPECTED_GEO) {
            log('geo', `MISMATCH — expected ${EXPECTED_GEO}, got ${info.country}. Skipping DMs.`);
          } else {
            log('geo', `OK — ${info.country}`);
            await sendDMs();
          }
        } catch (e) {
          log('geo', 'ERROR checking geo:', e.message, '— skipping DMs');
        }
      } else {
        await sendDMs();
      }
    }

    // ── 5. Update brief status ────────────────────────────────────────────────
    if (FORMAT === 'dm_only') {
      updateBrief({ status: 'posted', posted_at: new Date().toISOString(), amplification_done: true });
    } else if (postUrl) {
      updateBrief({ status: 'posted', post_url: postUrl, posted_url: postUrl, posted_at: new Date().toISOString(), amplification_done: true });
    } else {
      // Blotato confirmed publish but didn't return a URL — mark posted anyway
      updateBrief({ status: 'posted', posted_at: new Date().toISOString(), amplification_done: true });
    }

    // ── 6. Summary ────────────────────────────────────────────────────────────
    console.log('\n=== POST SUMMARY ===');
    console.log(`Brief:       ${BRIEF_ID}`);
    console.log(`Post status: ${FORMAT === 'dm_only' ? 'dm_only (no post)' : 'posted via Blotato ✓'}`);
    console.log(`Post URL:    ${postUrl || 'N/A (check Blotato dashboard)'}`);
    console.log(`DMs sent:    ${dmsSent}`);
    console.log('===================');

  } catch (e) {
    log('fatal', e.message);
    log('fatal', e.stack);
    updateBrief({ status: 'failed', error: e.message, posted_at: new Date().toISOString() });
    process.exit(1);
  }

  process.exit(0);

  // ── DM helper (Playwright) ───────────────────────────────────────────────────
  async function sendDMs() {
    const { chromium } = require('playwright');

    // Kill stale SingletonLock
    try {
      execSync(
        `fuser -k '${SESSION_DIR}/SingletonLock' 2>/dev/null || pkill -f 'user-data-dir=${SESSION_DIR}' 2>/dev/null || true`,
        { timeout: 5000 }
      );
      await new Promise(r => setTimeout(r, 1000));
    } catch {}
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(SESSION_DIR, f);
      if (fs.existsSync(p)) { fs.unlinkSync(p); log('dm', `Removed ${f}`); }
    }

    const opts = {
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    };
    if (PROXY_URL) {
      const u = new URL(PROXY_URL.includes('://') ? PROXY_URL : 'http://' + PROXY_URL);
      opts.proxy = { server: u.protocol + '//' + u.host };
      if (u.username) opts.proxy.username = decodeURIComponent(u.username);
      if (u.password) opts.proxy.password = decodeURIComponent(u.password);
    }

    const context = await chromium.launchPersistentContext(SESSION_DIR, opts);
    const page    = context.pages()[0] || await context.newPage();

    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      const isLoggedIn = await page.evaluate(() =>
        !document.querySelector('input[name="username"]') && !document.querySelector('form[id="loginForm"]')
      );
      if (!isLoggedIn) {
        log('dm', 'ERROR: Session expired — skipping DMs');
        await context.close();
        return;
      }

      for (const lead of DM_LEADS) {
        try {
          const username = lead.username.replace(/^@/, '');
          await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page.waitForTimeout(3000);

          const clicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('div[role="button"], button, a[role="link"]')];
            const btn  = btns.find(b => {
              const t = b.textContent.trim();
              return t === 'Message' || t === 'رسالة' || t === 'Send message' || t === 'إرسال رسالة';
            });
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (!clicked) { log('dm', `  No Message button for @${username} — skipping`); continue; }

          await page.waitForTimeout(4000);

          const msgBox = page.locator(['div[contenteditable="true"]', 'div[role="textbox"]', 'p[data-lexical-editor="true"]'].join(', ')).first();
          if (await msgBox.isVisible({ timeout: 10000 }).catch(() => false)) {
            await msgBox.click();
            await page.keyboard.type(lead.message, { delay: 40 });
            await page.waitForTimeout(1000);
            const sent = await page.evaluate(() => {
              const btns = [...document.querySelectorAll('div[role="button"], button')];
              const btn  = btns.find(b => b.textContent.trim() === 'Send' || b.textContent.trim() === 'إرسال');
              if (btn) { btn.click(); return true; }
              return false;
            });
            if (!sent) await page.keyboard.press('Enter');
            await page.waitForTimeout(2000);
            dmsSent++;
            log('dm', `  Sent DM to @${username}`);

            if (LEADS_FILE && fs.existsSync(LEADS_FILE)) {
              try {
                const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
                const l = leads.find(x => x.username === username || '@' + x.username === lead.username);
                if (l) { l.engagement_stage = 6; l.updated_at = new Date().toISOString(); fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); }
              } catch (e) { log('dm', '  ERROR updating leads:', e.message); }
            }

            if (OUTREACH_LOG) {
              fs.appendFileSync(OUTREACH_LOG, JSON.stringify({
                timestamp: new Date().toISOString(), action_type: 'dm', platform: 'instagram',
                username: lead.username, content_used: lead.message, brief_id: BRIEF_ID,
              }) + '\n');
            }
          } else {
            log('dm', `  Message box not found for @${username}`);
          }

          await page.waitForTimeout(10000 + Math.random() * 15000);
        } catch (e) {
          log('dm', `  ERROR DM-ing @${lead.username}:`, e.message);
        }
      }
    } finally {
      await context.close();
    }
  }
})();
