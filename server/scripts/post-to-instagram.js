#!/usr/bin/env node
/**
 * post-to-instagram.js — Static Instagram posting script for precision briefs.
 *
 * NEVER write this script from a Claude run — it is version-controlled and
 * injected with run-specific data via environment variables by the server.
 * See server/scripts/README.md for the full platform-scripts pattern.
 *
 * Required env vars:
 *   SESSION_DIR          — persistent browser session path
 *   INSTAGRAM_HANDLE     — account handle (without @)
 *   BRIEF_ID             — brief identifier
 *   BRIEFS_FILE          — absolute path to precision-briefs.json
 *   FORMAT               — carousel | post | story | dm_only
 *
 * Optional env vars:
 *   PROXY_URL            — http://user:pass@host:port
 *   BRIEF_TYPE           — product_carousel | standard (default: standard)
 *   CAPTION              — post caption text
 *   IMAGE_PATH           — absolute path to local image file (standard briefs)
 *   CAROUSEL_IMAGES      — JSON array of CDN image URLs (product_carousel briefs)
 *   SCREENSHOTS_DIR      — where to save screenshots (default: /tmp)
 *   DM_LEADS             — JSON array of {username, message} to DM after posting
 *   LEADS_FILE           — absolute path to leads.json (for stage updates after DM)
 *   OUTREACH_LOG         — absolute path to outreach-log.ndjson
 */

'use strict';

const { chromium }   = require('playwright');
const https          = require('https');
const http           = require('http');
const fs             = require('fs');
const path           = require('path');
const { execSync }   = require('child_process');

// ── Read env vars ─────────────────────────────────────────────────────────────
const SESSION_DIR     = process.env.SESSION_DIR;
const PROXY_URL       = process.env.PROXY_URL || '';
const HANDLE          = (process.env.INSTAGRAM_HANDLE || '').replace(/^@/, '');
const BRIEF_ID        = process.env.BRIEF_ID;
const BRIEF_TYPE      = process.env.BRIEF_TYPE || 'standard';
const FORMAT          = process.env.FORMAT || 'carousel';
const CAPTION         = process.env.CAPTION || '';
const IMAGE_PATH      = process.env.IMAGE_PATH || '';
const CAROUSEL_IMAGES = JSON.parse(process.env.CAROUSEL_IMAGES || '[]');
const BRIEFS_FILE     = process.env.BRIEFS_FILE;
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/tmp';
const DM_LEADS        = JSON.parse(process.env.DM_LEADS || '[]');
const LEADS_FILE      = process.env.LEADS_FILE || '';
const OUTREACH_LOG    = process.env.OUTREACH_LOG || '';
const EXPECTED_GEO    = process.env.EXPECTED_GEO || '';

if (!SESSION_DIR || !HANDLE || !BRIEF_ID || !BRIEFS_FILE) {
  console.error('[fatal] Missing required env vars: SESSION_DIR, INSTAGRAM_HANDLE, BRIEF_ID, BRIEFS_FILE');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag, ...args) {
  console.log(`[${tag}]`, ...args);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      res.pipe(file);
      file.on('finish', resolve);
    }).on('error', reject);
  });
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

function buildProxy() {
  if (!PROXY_URL) return null;
  const u = new URL(PROXY_URL.includes('://') ? PROXY_URL : 'http://' + PROXY_URL);
  return {
    server:   u.protocol + '//' + u.host,
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

// ── Geo check ─────────────────────────────────────────────────────────────────
if (PROXY_URL && EXPECTED_GEO) {
  log('geo', 'Checking proxy geo…');
  try {
    const out = execSync(
      `curl -s -x '${PROXY_URL}' --max-time 20 --connect-timeout 15 https://ipinfo.io/json`,
      { encoding: 'utf8', timeout: 25000 }
    );
    const info = JSON.parse(out);
    if (info.country !== EXPECTED_GEO) {
      log('geo', `MISMATCH — expected ${EXPECTED_GEO}, got ${info.country}. STOP.`);
      updateBrief({ status: 'failed', error: `geo_mismatch:${info.country}` });
      process.exit(1);
    }
    log('geo', `OK — ${info.country} (${info.city || ''})`);
  } catch (e) {
    log('geo', 'ERROR checking geo:', e.message, '— continuing without verification');
  }
} else {
  log('geo', 'No proxy configured — skipping geo check');
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let postUrl = null;
  let dmsSent = 0;

  // Remove stale SingletonLock
  const lockFile = path.join(SESSION_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
    log('session', 'Removed stale SingletonLock');
  }

  const opts = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  };
  const proxy = buildProxy();
  if (proxy) opts.proxy = proxy;

  const context = await chromium.launchPersistentContext(SESSION_DIR, opts);
  const page    = context.pages()[0] || await context.newPage();

  try {
    // ── 1. Verify session ──────────────────────────────────────────────────
    log('auth', 'Navigating to Instagram…');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const isLoggedIn = await page.evaluate(() =>
      !document.querySelector('input[name="username"]') &&
      !document.querySelector('form[id="loginForm"]')
    );
    if (!isLoggedIn) {
      log('auth', 'ERROR: Session expired — manual login required. STOP.');
      updateBrief({ status: 'failed', error: 'session_expired' });
      await context.close();
      process.exit(1);
    }
    log('auth', `Logged in as @${HANDLE}`);

    // ── 2. dm_only: skip Instagram post ───────────────────────────────────
    if (FORMAT === 'dm_only') {
      log('post', 'Format is dm_only — skipping Instagram post, going straight to DMs');
    } else {
      // ── 3. Warmup scroll ────────────────────────────────────────────────
      log('warmup', 'Scrolling feed for 30s…');
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Space');
        await page.waitForTimeout(5000);
      }

      // ── 4. Resolve image files ───────────────────────────────────────────
      let imageFiles = [];

      if (BRIEF_TYPE === 'product_carousel' && CAROUSEL_IMAGES.length) {
        log('images', `Downloading ${CAROUSEL_IMAGES.length} carousel image(s) from CDN…`);
        for (let i = 0; i < CAROUSEL_IMAGES.length; i++) {
          const dest = `/tmp/carousel-${BRIEF_ID}-${i}.jpg`;
          await downloadFile(CAROUSEL_IMAGES[i], dest);
          imageFiles.push(dest);
          log('images', `  Downloaded ${i + 1}/${CAROUSEL_IMAGES.length} → ${dest}`);
        }
      } else if (IMAGE_PATH) {
        if (!fs.existsSync(IMAGE_PATH)) {
          log('images', `ERROR: Image not found at ${IMAGE_PATH}`);
          updateBrief({ status: 'failed', error: 'image_not_found' });
          await context.close();
          process.exit(1);
        }
        imageFiles = [IMAGE_PATH];
        log('images', `Using local image: ${IMAGE_PATH}`);
      } else {
        log('images', 'ERROR: No IMAGE_PATH or CAROUSEL_IMAGES provided');
        updateBrief({ status: 'failed', error: 'no_image' });
        await context.close();
        process.exit(1);
      }

      // ── 5. Open Create → Post ────────────────────────────────────────────
      log('post', 'Opening Create dropdown…');
      await page.locator('svg[aria-label="New post"], a[href="#"][role="link"] svg').first().click();
      await page.waitForTimeout(1500);

      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[role="link"]'));
        const post  = links.find(l => l.textContent.trim() === 'Post');
        if (post) post.click();
      });
      await page.waitForSelector('div[role="dialog"]', { timeout: 10000 });
      log('post', 'Create dialog open');

      // ── 6. Upload image(s) ───────────────────────────────────────────────
      const fileInput = page.locator('input[type="file"]').first();
      // Pass all files at once — Instagram's file input accepts multiple
      await fileInput.setInputFiles(imageFiles);
      await page.waitForTimeout(3000);
      log('post', `Uploaded ${imageFiles.length} file(s)`);

      // For multi-image: if only first loaded, click "Add more" for remaining
      if (imageFiles.length > 1) {
        for (let i = 1; i < imageFiles.length; i++) {
          const added = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button, div[role="button"], span[role="button"]')];
            const btn  = btns.find(b =>
              (b.getAttribute('aria-label') || '').toLowerCase().includes('add') ||
              b.textContent.trim() === '+'
            );
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (added) {
            await page.waitForTimeout(1000);
            const moreInput = page.locator('input[type="file"]').first();
            await moreInput.setInputFiles(imageFiles[i]);
            await page.waitForTimeout(2000);
            log('post', `  Added carousel image ${i + 1}`);
          }
        }
      }

      // ── 7. Advance through crop → filter → caption screens ───────────────
      for (let i = 0; i < 3; i++) {
        const next = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').last();
        if (await next.isVisible({ timeout: 4000 }).catch(() => false)) {
          await next.click();
          await page.waitForTimeout(2000);
          log('post', `  Clicked Next (step ${i + 1})`);
        }
      }

      // ── 8. Type caption ──────────────────────────────────────────────────
      const captionBox = page.locator(
        'div[role="textbox"], textarea[placeholder*="caption"], div[contenteditable="true"]'
      ).first();
      if (await captionBox.isVisible({ timeout: 5000 }).catch(() => false)) {
        await captionBox.click();
        await page.keyboard.type(CAPTION, { delay: 40 });
        await page.waitForTimeout(1500);
        log('post', 'Caption typed');
      } else {
        log('post', 'WARNING: Caption box not found — posting without caption');
      }

      // ── 9. Share ─────────────────────────────────────────────────────────
      const shared = await page.evaluate(() => {
        const all = [...document.querySelectorAll('div[role="button"], button, span[role="button"], div')];
        const btn = all.find(el => el.textContent.trim() === 'Share' && el.offsetParent !== null);
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!shared) {
        await page.locator(':text-is("Share")').last().click({ force: true });
      }
      await page.waitForTimeout(6000);
      log('post', 'Share clicked — waiting for publish…');

      // ── 10. Verify post on own profile ────────────────────────────────────
      await page.goto(`https://www.instagram.com/${HANDLE}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(4000);
      await page.waitForSelector('a[href*="/p/"]', { timeout: 10000 }).catch(() => {});

      const firstPost = page.locator('a[href*="/p/"]').first();
      if (await firstPost.isVisible({ timeout: 5000 }).catch(() => false)) {
        await firstPost.click();
        await page.waitForTimeout(2000);
        const url = page.url();
        if (url.includes('/p/')) {
          postUrl = url;
          log('post', 'Verified post URL:', postUrl);
        } else {
          log('post', 'ERROR: URL after clicking first post is not a /p/ URL:', url);
        }
      } else {
        log('post', 'ERROR: No posts found in profile grid after posting');
      }

      // Screenshot
      const screenshotPath = path.join(SCREENSHOTS_DIR, `posted-${BRIEF_ID}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
      log('post', 'Screenshot saved:', screenshotPath);
    }

    // ── 11. DM step ───────────────────────────────────────────────────────────
    if (DM_LEADS.length > 0) {
      log('dm', `Sending DMs to ${DM_LEADS.length} lead(s)…`);
      for (const lead of DM_LEADS) {
        try {
          const username = lead.username.replace(/^@/, '');
          await page.goto(`https://www.instagram.com/${username}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
          });
          await page.waitForTimeout(2000);

          const msgClicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('div[role="button"], button')];
            const btn  = btns.find(b => b.textContent.trim() === 'Message');
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (!msgClicked) { log('dm', `  No Message button for @${username} — skipping`); continue; }

          await page.waitForTimeout(2000);
          const msgBox = page.locator('div[role="textbox"], textarea[placeholder*="message"]').first();
          if (await msgBox.isVisible({ timeout: 5000 }).catch(() => false)) {
            await msgBox.click();
            await page.keyboard.type(lead.message, { delay: 40 });
            await page.waitForTimeout(1000);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2000);
            dmsSent++;
            log('dm', `  Sent DM to @${username}`);

            // Update lead stage in leads.json
            if (LEADS_FILE && fs.existsSync(LEADS_FILE)) {
              try {
                const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
                const l = leads.find(x => x.username === username || '@' + x.username === lead.username);
                if (l) {
                  l.engagement_stage = 6;
                  l.updated_at = new Date().toISOString();
                  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
                }
              } catch (e) { log('dm', '  ERROR updating leads file:', e.message); }
            }

            // Append to outreach log
            if (OUTREACH_LOG) {
              const entry = JSON.stringify({
                timestamp:    new Date().toISOString(),
                action_type:  'dm',
                platform:     'instagram',
                username:     lead.username,
                content_used: lead.message,
                brief_id:     BRIEF_ID,
              }) + '\n';
              fs.appendFileSync(OUTREACH_LOG, entry);
            }
          } else {
            log('dm', `  Message box not found for @${username}`);
          }

          // Random cooldown between DMs
          const delay = 10000 + Math.random() * 15000;
          await page.waitForTimeout(delay);
        } catch (e) {
          log('dm', `  ERROR DM-ing @${lead.username}:`, e.message);
        }
      }
    }

    // ── 12. Update brief status ───────────────────────────────────────────────
    if (FORMAT === 'dm_only') {
      updateBrief({ status: 'posted', posted_at: new Date().toISOString(), amplification_done: true });
    } else if (postUrl) {
      updateBrief({
        status: 'posted',
        post_url: postUrl,
        posted_url: postUrl,
        posted_at: new Date().toISOString(),
        amplification_done: true,
      });
    } else {
      log('brief', 'ERROR: Could not verify post URL — marking as failed');
      updateBrief({ status: 'failed', posted_at: new Date().toISOString() });
    }

    // ── 13. Summary ───────────────────────────────────────────────────────────
    console.log('\n=== POST SUMMARY ===');
    console.log(`Brief:       ${BRIEF_ID}`);
    console.log(`Post status: ${FORMAT === 'dm_only' ? 'dm_only (no post)' : (postUrl ? 'posted ✓' : 'FAILED')}`);
    console.log(`Post URL:    ${postUrl || 'N/A'}`);
    console.log(`DMs sent:    ${dmsSent}`);
    console.log('===================');

  } catch (e) {
    log('fatal', e.message);
    log('fatal', e.stack);
    updateBrief({ status: 'failed', error: e.message, posted_at: new Date().toISOString() });
    try {
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `error-${BRIEF_ID}-${Date.now()}.png`),
      });
    } catch {}
    await context.close();
    process.exit(1);
  }

  await context.close();
  process.exit(FORMAT === 'dm_only' || postUrl ? 0 : 1);
})();
