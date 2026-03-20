#!/usr/bin/env node
/**
 * phase-b-pipeline.js — Instagram pipeline advancement (follows, comments, DMs).
 *
 * NEVER write this script from a Claude run — it is version-controlled.
 * Claude should call it with: node /app/server/scripts/phase-b-pipeline.js
 *
 * Required env vars:
 *   BASE_URL      — http://127.0.0.1:<PORT>
 *   CLIENT_ID     — client identifier
 *   SESSION_DIR   — Instagram browser session path
 *
 * Optional env vars:
 *   PROXY                — proxy URL (http://user:pass@host:port)
 *   MAX_LEADS            — max leads to process (default: 20)
 *   MAX_FOLLOWS          — max follows this session (default: 10)
 *   MAX_DMS              — max DMs this session (default: 8)
 *   MAX_COMMENTS         — max comments this session (default: 10)
 *   COOLDOWN_HOURS       — hours between touching same lead (default: 48)
 *   DM_FOLLOWBACK_DAYS   — days to wait after follow before DMing (default: 3)
 *   DELAY_MIN            — min ms between actions (default: 3000)
 *   DELAY_MAX            — max ms between actions (default: 8000)
 *   OUTREACH_LOG         — path to outreach-log.ndjson
 *   DM_SCORE_THRESHOLD   — min score to send DM (default: 60)
 *   COMMENT_SCORE_THRESHOLD — min score to comment (default: 40)
 *   BRAND_VOICE          — short brand voice string for DM opener style
 *   IS_AMBASSADOR        — "1" if ambassador account mode
 *   WHATSAPP_LINK        — WhatsApp link for pivot
 */

'use strict';

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const http         = require('http');

// ── Env vars ──────────────────────────────────────────────────────────────────
const BASE_URL          = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CLIENT_ID         = process.env.CLIENT_ID || '';
const SESSION_DIR       = process.env.SESSION_DIR || '';
const PROXY             = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const MAX_LEADS         = parseInt(process.env.MAX_LEADS || '20', 10);
const MAX_FOLLOWS       = parseInt(process.env.MAX_FOLLOWS || '10', 10);
const MAX_DMS           = parseInt(process.env.MAX_DMS || '8', 10);
const MAX_COMMENTS      = parseInt(process.env.MAX_COMMENTS || '10', 10);
const COOLDOWN_HOURS    = parseInt(process.env.COOLDOWN_HOURS || '48', 10);
const DM_FOLLOWBACK_DAYS = parseInt(process.env.DM_FOLLOWBACK_DAYS || '3', 10);
const DELAY_MIN         = parseInt(process.env.DELAY_MIN || '3000', 10);
const DELAY_MAX         = parseInt(process.env.DELAY_MAX || '8000', 10);
const OUTREACH_LOG      = process.env.OUTREACH_LOG || '';
const DM_SCORE          = parseInt(process.env.DM_SCORE_THRESHOLD || '60', 10);
const COMMENT_SCORE     = parseInt(process.env.COMMENT_SCORE_THRESHOLD || '40', 10);
const IS_AMBASSADOR     = process.env.IS_AMBASSADOR === '1';
const WHATSAPP_LINK     = process.env.WHATSAPP_LINK || '';

if (!CLIENT_ID || !SESSION_DIR) {
  console.error('[phase-b] ERROR: CLIENT_ID and SESSION_DIR are required');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randDelay = () => delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
const profileDelay = () => delay(30000 + Math.random() * 60000);

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
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
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
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
  } catch (e) { /* ignore */ }
}

function patchLead(username, updates) {
  return apiCall('PATCH', `/api/clients/${CLIENT_ID}/leadgen/leads/by-username`, {
    username,
    ...updates,
    updated_at: new Date().toISOString()
  });
}

async function fetchLeads(params) {
  const qs = new URLSearchParams(params).toString();
  const result = await apiCall('GET', `/api/clients/${CLIENT_ID}/leadgen/leads?${qs}`);
  return Array.isArray(result) ? result : (result.leads || []);
}

function isOnCooldown(lead) {
  if (!lead.last_engaged_at) return false;
  const hours = (Date.now() - new Date(lead.last_engaged_at).getTime()) / 3600000;
  return hours < COOLDOWN_HOURS;
}

function followbackWaitPassed(lead) {
  if (!lead.last_engaged_at) return false;
  const days = (Date.now() - new Date(lead.last_engaged_at).getTime()) / 86400000;
  return days >= DM_FOLLOWBACK_DAYS;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[phase-b] Starting pipeline for client ${CLIENT_ID}`);
  console.log(`[phase-b] Limits: ${MAX_LEADS} leads, ${MAX_FOLLOWS} follows, ${MAX_DMS} DMs, ${MAX_COMMENTS} comments`);

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
    console.error('[phase-b] Browser launch failed:', e.message);
    process.exit(1);
  }

  let follows = 0, dms = 0, comments = 0, processed = 0;

  // Priority groups to process in order
  const priorityGroups = [
    // Priority 0: Ad-sourced UAE leads at stage 3 (followed, needs DM)
    { stage: 3, source_type: 'competitor_ad_commenter', limit: 5, label: 'P0-ad-UAE' },
    // Priority 1: Influencers at stage 3
    { stage: 3, is_influencer: 1, limit: 5, label: 'P1-influencer' },
    // Priority 2: Hot leads (high score) at stage 3
    { stage: 3, minScore: DM_SCORE, limit: 10, label: 'P2-hot' },
    // Priority 3: Mid leads at stage 3
    { stage: 3, minScore: COMMENT_SCORE, limit: 10, label: 'P3-mid' },
    // Priority 4: Stage 4 leads (commented, need DM)
    { stage: 4, minScore: DM_SCORE, limit: 10, label: 'P4-comment-done' },
  ];

  for (const group of priorityGroups) {
    if (processed >= MAX_LEADS || dms >= MAX_DMS) break;

    const params = {
      platform: 'instagram',
      stage: group.stage,
      limit: group.limit,
    };
    if (group.minScore) params.minScore = group.minScore;
    if (group.source_type) params.source_type = group.source_type;
    if (group.is_influencer) params.is_influencer = 1;

    const leads = await fetchLeads(params);
    console.log(`[phase-b] ${group.label}: ${leads.length} leads`);

    for (const lead of leads) {
      if (processed >= MAX_LEADS || dms >= MAX_DMS) break;
      if (isOnCooldown(lead)) {
        console.log(`[phase-b] Skip @${lead.username} — on cooldown`);
        continue;
      }

      const profileUrl = `https://www.instagram.com/${lead.username}/`;
      console.log(`[phase-b] Processing @${lead.username} (stage ${lead.engagement_stage}, score ${lead.lead_score})`);

      try {
        // Stage 3 (followed) → try to send DM if followback wait passed
        if (lead.engagement_stage === 3 && lead.lead_score >= DM_SCORE && dms < MAX_DMS) {
          if (followbackWaitPassed(lead)) {
            // Send DM
            await page.goto(`https://www.instagram.com/direct/new/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(2000);

            // Type username in search
            const searchInput = page.locator('input[placeholder*="Search"]').first();
            if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
              await searchInput.fill(lead.username);
              await delay(1500);
              // Click on the result
              const result = page.locator(`text=${lead.username}`).first();
              if (await result.isVisible({ timeout: 5000 }).catch(() => false)) {
                await result.click();
                await delay(1000);
                // Click Next
                const nextBtn = page.locator('button:has-text("Next"), button:has-text("Chat")').first();
                if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                  await nextBtn.click();
                  await delay(1500);
                }

                // Build opener message
                const name = lead.name?.split(' ')[0] || lead.username;
                const lang = lead.notes?.includes('Arabic') || lead.username.match(/[ا-ي]/) ? 'ar' : 'en';
                let msg;
                if (IS_AMBASSADOR) {
                  msg = lang === 'ar'
                    ? `هلا ${name}! شفت إنك بتتابعين ${lead.source_handle || 'حساب النوم'}. أنا من فريق بامبو سليب بروفيسور — لو عندك أي سؤال عن مفارش البامبو أو جودة النوم يسعدني أساعدك 😊`
                    : `Hey ${name}! Noticed you follow ${lead.source_handle || 'sleep content'}. I'm with Bamboo Sleep Professor — happy to chat about bamboo bedding or sleep quality if you have questions 😊`;
                } else {
                  msg = lang === 'ar'
                    ? `هلا ${name}! شكراً لمتابعتك. لو عندك أي سؤال عن مفارشنا أو مواد البامبو يسعدنا نساعدك 😊`
                    : `Hey ${name}! Thanks for the follow. Let me know if you have any questions about our bamboo bedding 😊`;
                }

                const msgInput = page.locator('[contenteditable="true"], textarea[placeholder*="message"]').last();
                if (await msgInput.isVisible({ timeout: 5000 }).catch(() => false)) {
                  await msgInput.click();
                  await page.keyboard.type(msg, { delay: 50 + Math.random() * 80 });
                  await delay(800);
                  await page.keyboard.press('Enter');
                  await delay(1500);

                  dms++;
                  console.log(`[phase-b] ✅ DM sent to @${lead.username}`);
                  await patchLead(lead.username, { engagement_stage: 5, last_engaged_at: new Date().toISOString() });
                  logOutreach({ action_type: 'dm', platform: 'instagram', username: lead.username, content_used: msg, result: 'sent' });
                }
              }
            }
          } else {
            console.log(`[phase-b] @${lead.username} — followback wait not passed yet`);
          }
        }

        // Stage 3 with mid score → leave a comment on their recent post
        else if (lead.engagement_stage === 3 && lead.lead_score >= COMMENT_SCORE && comments < MAX_COMMENTS) {
          await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await delay(2000 + Math.random() * 2000);

          // Click first post
          const firstPost = page.locator('article a, div[style*="padding-bottom"] a').first();
          if (await firstPost.isVisible({ timeout: 5000 }).catch(() => false)) {
            await firstPost.click();
            await delay(2000);

            const commentBox = page.locator('[aria-label="Add a comment…"], [placeholder*="comment"]').first();
            if (await commentBox.isVisible({ timeout: 5000 }).catch(() => false)) {
              const lang = lead.notes?.includes('Arabic') ? 'ar' : 'en';
              const comments_pool = lang === 'ar'
                ? ['محتوى رائع! 😍', 'أسلوبك يعجبني 🌿', 'مشاركة جميلة! ✨', 'هذا المحتوى مفيد جداً 🙏']
                : ['Love this! 🌿', 'Such a beautiful space ✨', 'This is so inspiring 😍', 'Great content! 💚'];
              const comment = comments_pool[Math.floor(Math.random() * comments_pool.length)];

              await commentBox.click();
              await page.keyboard.type(comment, { delay: 60 + Math.random() * 80 });
              await delay(600);
              await page.keyboard.press('Enter');
              await delay(1500);

              comments++;
              console.log(`[phase-b] ✅ Comment on @${lead.username}: "${comment}"`);
              await patchLead(lead.username, { engagement_stage: 4, last_engaged_at: new Date().toISOString() });
              logOutreach({ action_type: 'comment', platform: 'instagram', username: lead.username, content_used: comment, result: 'posted' });
            }
          }
        }

        processed++;
        await profileDelay();

      } catch (err) {
        console.error(`[phase-b] Error processing @${lead.username}:`, err.message);
        // Continue to next lead
      }
    }
  }

  await context.close();
  console.log(`[phase-b] Done. Processed ${processed} leads | DMs: ${dms} | Comments: ${comments} | Follows: ${follows}`);
})();
