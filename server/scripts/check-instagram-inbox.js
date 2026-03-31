#!/usr/bin/env node
/**
 * check-instagram-inbox.js — Scan Instagram DM inbox for unread replies from known leads.
 *
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/check-instagram-inbox.js
 *
 * Required env vars:
 *   CLIENT_ID     — client identifier
 *   SESSION_DIR   — Instagram browser session path
 *   LEADS_FILE    — absolute path to leads.json
 *
 * Optional env vars:
 *   PROXY              — proxy URL
 *   OUTREACH_LOG       — path to outreach-log.ndjson
 *   MAX_THREADS        — max inbox threads to scan (default: 50)
 *   REPLIES_LOG        — path to write unread replies JSON (default: DATA_DIR/logs/inbox-replies.json)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CLIENT_ID   = process.env.CLIENT_ID   || '';
const SESSION_DIR = process.env.SESSION_DIR || '';
const LEADS_FILE  = process.env.LEADS_FILE  || '';
const PROXY       = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const OUTREACH_LOG = process.env.OUTREACH_LOG || '';
const MAX_THREADS  = parseInt(process.env.MAX_THREADS || '50', 10);
const REPLIES_LOG  = process.env.REPLIES_LOG ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'logs', 'inbox-replies.json') : '/tmp/inbox-replies.json');

if (!CLIENT_ID || !SESSION_DIR || !LEADS_FILE) {
  console.error('[inbox] ERROR: CLIENT_ID, SESSION_DIR, and LEADS_FILE are required');
  process.exit(1);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

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

function loadRepliesLog() {
  try { return JSON.parse(fs.readFileSync(REPLIES_LOG, 'utf8')); } catch { return []; }
}

function saveRepliesLog(entries) {
  fs.mkdirSync(path.dirname(REPLIES_LOG), { recursive: true });
  fs.writeFileSync(REPLIES_LOG, JSON.stringify(entries, null, 2));
}

// Dismiss common overlays
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

(async () => {
  console.log(`[inbox] Starting inbox check for ${CLIENT_ID}`);

  const leads = loadLeads();
  // Build a map: instagram username (lowercase) → lead index
  const igLeadMap = new Map();
  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    if (l.platform === 'instagram' && l.username) {
      igLeadMap.set(l.username.toLowerCase(), i);
    }
  }
  console.log(`[inbox] Tracking ${igLeadMap.size} Instagram leads`);

  // Build browser options
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

  let context, page;
  try {
    context = await chromium.launchPersistentContext(SESSION_DIR, launchOpts);
    page = context.pages()[0] || await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' });
  } catch (e) {
    console.error('[inbox] Browser launch failed:', e.message);
    process.exit(1);
  }

  // Verify session
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000);
    if (page.url().includes('accounts/login')) {
      console.error('[inbox] STOP: Instagram session expired — re-login via admin VNC');
      await context.close();
      process.exit(1);
    }
    console.log('[inbox] ✅ Session active');
  } catch (e) {
    console.error('[inbox] ERROR loading Instagram:', e.message);
    await context.close();
    process.exit(1);
  }

  // Navigate to inbox
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log(`[inbox] inbox navigation error: ${e.message}`);
    await context.close();
    process.exit(1);
  }
  await delay(4000);
  await dismissOverlays(page);
  await delay(1000);

  // Scroll the thread list to load more threads
  const threadListSel = '[role="list"], div[style*="overflow"]';
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const el = document.querySelector('[role="list"]');
      if (el) el.scrollBy(0, 600);
      else window.scrollBy(0, 600);
    });
    await delay(1500);
  }

  // Extract thread items: username + unread indicator
  const threads = await page.evaluate(() => {
    const results = [];
    // Thread list items — Instagram uses a div with role="listitem" or similar
    const items = Array.from(document.querySelectorAll('[role="listitem"], [role="list"] > div > div'));
    for (const item of items) {
      // Username: look for a span that looks like a handle, or a header link
      const links = Array.from(item.querySelectorAll('a[href*="/direct/"]'));
      const threadLink = links[0];
      if (!threadLink) continue;

      // Extract username from the thread title / link text / aria-label
      const ariaLabel = threadLink.getAttribute('aria-label') || '';
      const titleEl = item.querySelector('span[dir], h4, h5');
      const titleText = (titleEl ? titleEl.innerText : '').trim();

      // Unread indicator: Instagram marks unread threads with a blue dot or bold text
      const boldEl = item.querySelector('[style*="font-weight: 600"], [style*="font-weight:600"], strong');
      const blueDot = item.querySelector('span[style*="background"], div[style*="background-color: rgb(0, 149, 246)"]');
      const isUnread = !!(boldEl || blueDot);

      // Try to get preview text
      const spans = Array.from(item.querySelectorAll('span[dir]'));
      const preview = spans.map(s => s.innerText).join(' ').trim().slice(0, 200);

      results.push({
        ariaLabel,
        titleText,
        preview,
        isUnread,
        href: threadLink.href || '',
      });
    }
    return results;
  }).catch(() => []);

  console.log(`[inbox] Found ${threads.length} threads in inbox`);

  const existingReplies = loadRepliesLog();
  const existingKeys = new Set(existingReplies.map(r => r.thread_href || r.username));

  const newReplies = [];
  let checkedCount = 0;
  let newFromLeads = 0;
  let leadsUpdated = 0;

  for (const thread of threads.slice(0, MAX_THREADS)) {
    checkedCount++;
    if (!thread.href) continue;

    // Identify the username from the thread
    // href format: https://www.instagram.com/direct/t/THREAD_ID  — no username directly
    // titleText or ariaLabel often has the display name or username
    // We'll try to match against known leads by titleText
    const titleLower = (thread.titleText || thread.ariaLabel || '').toLowerCase().replace(/^conversation with /i, '');
    const matchedLeadIdx = igLeadMap.get(titleLower);
    const isKnownLead = matchedLeadIdx !== undefined;

    // Open the thread only if it's unread OR from a known lead we haven't seen yet
    const shouldOpen = thread.isUnread || (isKnownLead && !existingKeys.has(titleLower));

    if (!shouldOpen) continue;
    if (existingKeys.has(thread.href)) continue;

    console.log(`[inbox] Opening thread: "${thread.titleText}" (unread: ${thread.isUnread}, knownLead: ${isKnownLead})`);

    try {
      await page.goto(thread.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await delay(3000);
      await dismissOverlays(page);

      // Extract messages from the thread
      const messages = await page.evaluate(() => {
        const msgs = [];
        // Message bubbles
        const bubbles = Array.from(document.querySelectorAll('[role="row"], [data-testid*="message"], div[class*="message"]'));
        for (const b of bubbles) {
          const text = (b.innerText || '').trim();
          if (!text || text.length < 2) continue;
          // Determine direction: outgoing (ours) vs incoming (theirs)
          const isOutgoing = b.getAttribute('aria-label')?.includes('You') ||
                             b.style?.textAlign === 'right' ||
                             b.className?.includes('outgoing');
          msgs.push({ text: text.slice(0, 500), isOutgoing });
        }
        return msgs;
      }).catch(() => []);

      // Try to get the actual Instagram username from the profile header in thread
      const threadUsername = await page.evaluate(() => {
        // Header of the DM thread often has a link to the profile
        const headerLink = document.querySelector('header a[href*="/"], div[role="main"] a[href*="/instagram.com"]');
        if (headerLink) {
          const href = headerLink.href || '';
          const m = href.match(/instagram\.com\/([^/?#]+)/);
          return m ? m[1] : null;
        }
        return null;
      }).catch(() => null);

      const username = threadUsername || titleLower;
      const incomingMessages = messages.filter(m => !m.isOutgoing);
      const latestIncoming = incomingMessages[incomingMessages.length - 1]?.text || '';

      const replyEntry = {
        username,
        display_name: thread.titleText || thread.ariaLabel,
        thread_href: thread.href,
        is_unread: thread.isUnread,
        is_known_lead: isKnownLead,
        latest_message: latestIncoming,
        preview: thread.preview,
        checked_at: new Date().toISOString(),
      };

      newReplies.push(replyEntry);
      existingKeys.add(thread.href);
      existingKeys.add(username.toLowerCase());

      if (thread.isUnread && isKnownLead && latestIncoming) {
        newFromLeads++;
        console.log(`[inbox] 📬 REPLY from known lead @${username}: "${latestIncoming.slice(0, 80)}"`);

        // Update lead record: mark as replied (stage 6), record reply
        const idx = matchedLeadIdx ?? igLeadMap.get(username.toLowerCase());
        if (idx !== undefined && leads[idx]) {
          if (leads[idx].engagement_stage < 6) {
            leads[idx].engagement_stage = 6;
          }
          leads[idx].last_replied_at = new Date().toISOString();
          leads[idx].last_reply_text = latestIncoming.slice(0, 300);
          leads[idx].updated_at = new Date().toISOString();
          leadsUpdated++;
        }

        logOutreach({
          action_type: 'inbox_reply_detected',
          platform: 'instagram',
          username,
          content_used: latestIncoming.slice(0, 300),
          result: 'reply_received',
          client_id: CLIENT_ID,
        });
      } else if (thread.isUnread) {
        console.log(`[inbox] 📩 Unread (not a tracked lead): "${thread.titleText}" — "${latestIncoming.slice(0, 60)}"`);
      }

      await delay(2000 + Math.random() * 2000);
    } catch (e) {
      console.log(`[inbox] Error opening thread "${thread.titleText}": ${e.message}`);
      try { await page.evaluate('window.stop()'); } catch {}
      await delay(2000);
    }
  }

  if (leadsUpdated > 0) saveLeads(leads);

  // Merge new replies into log
  const allReplies = [...existingReplies, ...newReplies];
  saveRepliesLog(allReplies);

  await context.close();

  console.log(`\n[inbox] ═══ INBOX CHECK SUMMARY ═══`);
  console.log(`[inbox] Threads scanned:      ${checkedCount}`);
  console.log(`[inbox] Replies from leads:   ${newFromLeads}`);
  console.log(`[inbox] Lead records updated: ${leadsUpdated}`);
  console.log(`[inbox] Replies log:          ${REPLIES_LOG}`);
  console.log(`[inbox] ════════════════════════════`);
})();
