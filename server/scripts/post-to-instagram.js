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

  // Kill any live Chrome process that still holds the session, then clean all lock files.
  // A running process will immediately recreate SingletonLock if we only delete the file.
  try {
    execSync(
      `fuser -k '${SESSION_DIR}/SingletonLock' 2>/dev/null || pkill -f 'user-data-dir=${SESSION_DIR}' 2>/dev/null || true`,
      { timeout: 5000 }
    );
    await new Promise(r => setTimeout(r, 1000)); // let process die
  } catch {}
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(SESSION_DIR, f);
    if (fs.existsSync(p)) { fs.unlinkSync(p); log('session', `Removed ${f}`); }
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
      log('warmup', 'Scrolling feed for 15s…');
      for (let i = 0; i < 3; i++) {
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

      // IMPORTANT: click the parent <a>/<div> element that wraps the Create SVG icon.
      // Clicking the SVG directly may not propagate to the link's click handler.
      // Instagram's Create button is typically: <a role="link"><svg aria-label="New post"/></a>
      const createBtnClicked = await page.evaluate(() => {
        // Find via SVG aria-label, then walk up to the clickable ancestor
        const svg = document.querySelector(
          'svg[aria-label="New post"], svg[aria-label="Create"], svg[aria-label="إنشاء"]'
        );
        if (svg) {
          const clickable = svg.closest('a, [role="button"], [role="link"]');
          if (clickable) { clickable.click(); return 'via-ancestor'; }
          svg.click(); return 'svg-direct';
        }
        // Fallback: look for any element with aria-label Create/New post
        const el = document.querySelector(
          '[aria-label="New post"], [aria-label="Create"], [aria-label="إنشاء"]'
        );
        if (el) { el.click(); return 'via-aria'; }
        return null;
      });
      log('post', 'Create button click strategy:', createBtnClicked || 'NOT FOUND');
      await page.waitForTimeout(1500);

      // Screenshot to see what the dropdown looks like
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `create-menu-${BRIEF_ID}-${Date.now()}.png`) });

      // Click "Post" from the dropdown menu that appears
      // The menu items may have role="link" (old UI) or no role (new UI)
      const postClicked = await page.evaluate(() => {
        // Look for an element with text exactly "Post" that is now visible
        const all = [
          ...document.querySelectorAll('a, [role="menuitem"], [role="link"], span, div'),
        ];
        const candidates = all.filter(el => {
          const t = el.textContent.trim();
          return (t === 'Post' || t === 'منشور') && el.offsetParent !== null;
        });
        // Prefer smallest element (most specific match)
        candidates.sort((a, b) => (a.textContent.length - b.textContent.length));
        if (candidates[0]) { candidates[0].click(); return candidates[0].tagName + ':' + candidates[0].textContent.trim(); }
        return null;
      });
      log('post', 'Post menu item click:', postClicked || 'NOT FOUND');
      await page.waitForTimeout(1000);

      // Wait for the upload dialog — try multiple selector variants with a longer timeout
      // Instagram may use div[role="dialog"], a named dialog, or a custom class
      const dialogAppeared = await Promise.race([
        page.waitForSelector('div[role="dialog"]',            { timeout: 15000 }).then(() => 'dialog'),
        page.waitForSelector('[aria-label="Create new post"]',{ timeout: 15000 }).then(() => 'create-new-post'),
        page.waitForSelector('button:has-text("Select from computer")', { timeout: 15000 }).then(() => 'select-btn'),
        page.waitForSelector('input[type="file"]',            { timeout: 15000 }).then(() => 'file-input'),
      ]).catch(() => null);

      if (!dialogAppeared) {
        // Final screenshot to show current state, then bail
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `dialog-timeout-${BRIEF_ID}-${Date.now()}.png`) });
        throw new Error('Create post dialog never appeared — check dialog-timeout screenshot');
      }
      log('post', 'Create dialog open (detected via:', dialogAppeared + ')');

      // ── 6. Upload image(s) ───────────────────────────────────────────────
      // Screenshot the dialog so we can diagnose any upload issues from run logs
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `create-dialog-${BRIEF_ID}-${Date.now()}.png`) });

      // Set up the filechooser listener BEFORE clicking (must be registered first)
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 20000 });

      // Try to click the "Select from computer" button using Playwright's locator
      // (case-insensitive, handles Arabic variant too; falls back to clicking the dialog area)
      const uploadBtn = page.locator([
        'button:has-text("Select from computer")',
        'button:has-text("اختر من الكمبيوتر")',
        'button:has-text("Select From Computer")',
        'div[role="button"]:has-text("Select from computer")',
        '[aria-label="Upload photo or video"]',
        '[aria-label="Upload"]',
      ].join(', ')).first();

      const btnVisible = await uploadBtn.isVisible({ timeout: 8000 }).catch(() => false);
      if (btnVisible) {
        log('post', 'Clicking "Select from computer" button…');
        await uploadBtn.click();
      } else {
        // Fallback: click the drag-drop area in the center of the dialog
        log('post', '"Select from computer" not found by text — clicking dialog drop zone…');
        const dialogBox = await page.locator('div[role="dialog"]').boundingBox();
        if (dialogBox) {
          await page.mouse.click(
            dialogBox.x + dialogBox.width / 2,
            dialogBox.y + dialogBox.height / 2,
          );
        } else {
          // Last resort: look for any input[type="file"] and trigger a click via JS
          await page.evaluate(() => {
            const inp = document.querySelector('input[type="file"]');
            if (inp) inp.click();
          });
        }
      }

      // Wait for file chooser; if it times out try direct setInputFiles on the hidden input
      let uploadedViaChooser = false;
      try {
        const fileChooser = await fileChooserPromise;
        // Pass ALL files at once — Instagram handles multi-file as carousel automatically
        await fileChooser.setFiles(imageFiles);
        uploadedViaChooser = true;
        log('post', `Uploaded ${imageFiles.length} file(s) via file chooser`);
      } catch (chooserErr) {
        log('post', `filechooser timed out (${chooserErr.message}), trying direct setInputFiles…`);
        const fi = page.locator('input[type="file"]').first();
        try {
          await fi.setInputFiles(imageFiles, { timeout: 15000 });
          log('post', `Uploaded ${imageFiles.length} file(s) via direct setInputFiles`);
        } catch (inputErr) {
          // Log the dialog HTML for debugging, then throw so the run fails clearly
          const dialogHtml = await page.evaluate(() => {
            const d = document.querySelector('div[role="dialog"]');
            return d ? d.innerHTML.substring(0, 2000) : 'dialog not found';
          });
          log('post', 'Dialog HTML snapshot:', dialogHtml);
          throw new Error(`Image upload failed — filechooser: ${chooserErr.message} / setInputFiles: ${inputErr.message}`);
        }
      }
      await page.waitForTimeout(3000);

      // For product carousels: Instagram accepts multiple files from the chooser in one go.
      // If only 1 image loaded (Instagram picked only the first), use the "Add photos" button.
      if (imageFiles.length > 1 && uploadedViaChooser) {
        // Check if Instagram is showing a "select multiple" / carousel indicator
        // If not, click "Add photos" button for each additional image
        for (let i = 1; i < imageFiles.length; i++) {
          const addBtnVisible = await page.locator([
            'button[aria-label="Add photos or videos"]',
            'button[aria-label="Add"]',
            'div[role="button"][aria-label="Add"]',
            'svg[aria-label="Select multiple"]',
          ].join(', ')).first().isVisible({ timeout: 3000 }).catch(() => false);

          if (!addBtnVisible) {
            log('post', `  No "Add" button found for image ${i + 1} — Instagram may have loaded all files already`);
            break;
          }

          const moreChooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });
          await page.locator([
            'button[aria-label="Add photos or videos"]',
            'button[aria-label="Add"]',
            'div[role="button"][aria-label="Add"]',
          ].join(', ')).first().click().catch(() => {});

          try {
            const moreChooser = await moreChooserPromise;
            await moreChooser.setFiles(imageFiles[i]);
            await page.waitForTimeout(2000);
            log('post', `  Added carousel image ${i + 1}`);
          } catch {
            log('post', `  Could not add carousel image ${i + 1} — skipping`);
            break;
          }
        }
      }

      // ── 7. Advance through crop → filter → caption screens ───────────────
      // Screenshot before Next clicks so we can see what screen we're on
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `pre-next-${BRIEF_ID}-${Date.now()}.png`) });
      for (let i = 0; i < 3; i++) {
        const next = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').last();
        if (await next.isVisible({ timeout: 4000 }).catch(() => false)) {
          await next.click();
          await page.waitForTimeout(2500);
          log('post', `  Clicked Next (step ${i + 1})`);
          await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `next-${i+1}-${BRIEF_ID}-${Date.now()}.png`) });
        } else {
          log('post', `  No Next button found at step ${i + 1} — may already be on caption screen`);
          break;
        }
      }

      // ── 8. Type caption ──────────────────────────────────────────────────
      const captionBox = page.locator(
        'div[aria-label="Write a caption..."], div[role="textbox"], textarea[placeholder*="caption"], div[contenteditable="true"]'
      ).first();
      if (await captionBox.isVisible({ timeout: 5000 }).catch(() => false)) {
        await captionBox.click();
        await page.keyboard.type(CAPTION, { delay: 30 });
        await page.waitForTimeout(1500);
        log('post', 'Caption typed');
      } else {
        log('post', 'WARNING: Caption box not found — posting without caption');
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `no-caption-box-${BRIEF_ID}-${Date.now()}.png`) });
      }

      // ── 9. Share ─────────────────────────────────────────────────────────
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `pre-share-${BRIEF_ID}-${Date.now()}.png`) });

      // Log visible dialog text so we can see what screen we're actually on
      const preShareText = await page.evaluate(() => {
        const d = document.querySelector('div[role="dialog"]');
        return d ? d.innerText.substring(0, 500) : '(no dialog)';
      });
      log('post', 'Dialog text before Share:', preShareText);

      // Find and click Share (or Post/Publish — IG uses different labels in different locales)
      const sharedBtn = await page.evaluate(() => {
        const candidates = ['Share', 'شارك', 'Post', 'Publish', 'انشر'];
        const all = [...document.querySelectorAll('div[role="button"], button, span[role="button"]')];
        for (const label of candidates) {
          const btn = all.find(el => el.textContent.trim() === label && el.offsetParent !== null);
          if (btn) { btn.click(); return label; }
        }
        return null;
      });
      if (sharedBtn) {
        log('post', `Share clicked (label: "${sharedBtn}")`);
      } else {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `share-not-found-${BRIEF_ID}-${Date.now()}.png`) });
        throw new Error('Share/Post button not found — check share-not-found screenshot');
      }
      log('post', 'Waiting for publish confirmation…');

      // Instagram's post flow after Share:
      //   1. Loading spinner (dialog still open)
      //   2. "Your post has been shared." success screen (dialog still open) + a Close button
      //   3. Click Close → dialog disappears
      // Some variants auto-close. We handle both.
      //
      // Use waitForFunction (not waitForSelector with :text()) for text detection
      const publishResult = await Promise.race([
        page.waitForFunction(() => {
          const body = document.body.innerText || '';
          return body.includes('Your post has been shared') ||
                 body.includes('Post shared') ||
                 body.includes('تمت مشاركة منشورك') ||
                 body.includes('تم مشاركة');
        }, { timeout: 35000 }).then(() => 'success-text'),
        page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 35000 }).then(() => 'auto-close'),
      ]).catch(() => null);

      if (!publishResult) {
        // Log what the dialog says now (might be an error message)
        const stuckText = await page.evaluate(() => {
          const d = document.querySelector('div[role="dialog"]');
          return d ? d.innerText.substring(0, 800) : '(dialog gone)';
        });
        log('post', 'Dialog text when stuck:', stuckText);
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `share-stuck-${BRIEF_ID}-${Date.now()}.png`) });
        throw new Error(`Post dialog did not confirm publish after 35s. Dialog said: "${stuckText.substring(0, 200)}"`);
      }

      if (publishResult === 'success-text') {
        log('post', 'Post published — success text detected. Clicking Close…');
        const closedViaBtn = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, div[role="button"], a')];
          const btn = btns.find(b => {
            const t = b.textContent.trim();
            return (t === 'Close' || t === 'إغلاق' || t === 'Done' || t === 'تم') && b.offsetParent !== null;
          });
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!closedViaBtn) await page.keyboard.press('Escape');
        await page.waitForTimeout(2000);
      } else {
        log('post', 'Dialog auto-closed — post published ✓');
      }
      await page.waitForTimeout(2000);

      // ── 10. Verify post on own profile ────────────────────────────────────
      await page.goto(`https://www.instagram.com/${HANDLE}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(5000);
      await page.waitForSelector('a[href*="/p/"]', { timeout: 10000 }).catch(() => {});

      // Get the href of the first post WITHOUT clicking — avoids navigating away
      const firstPostHref = await page.locator('a[href*="/p/"]').first().getAttribute('href').catch(() => null);
      if (firstPostHref) {
        postUrl = 'https://www.instagram.com' + firstPostHref.replace(/\/$/, '') + '/';
        log('post', 'Verified post URL:', postUrl);
      } else {
        log('post', 'ERROR: No /p/ posts found in profile grid after posting');
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

          // Go to profile and click Message button — most reliable path
          await page.goto(`https://www.instagram.com/${username}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
          });
          await page.waitForTimeout(3000);

          // Click the Message button (text varies by language)
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

          // Wait for DM thread to load (navigates to /direct/t/... or shows inline panel)
          await page.waitForTimeout(4000);

          // DM input selector — Instagram uses contenteditable div; aria-label is optional
          // Try multiple selectors in order of specificity
          const msgBox = page.locator([
            'div[contenteditable="true"]',
            'div[role="textbox"]',
            'p[data-lexical-editor="true"]',
          ].join(', ')).first();

          if (await msgBox.isVisible({ timeout: 10000 }).catch(() => false)) {
            await msgBox.click();
            await page.keyboard.type(lead.message, { delay: 40 });
            await page.waitForTimeout(1000);
            // Send via Enter (or click Send button as fallback)
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
