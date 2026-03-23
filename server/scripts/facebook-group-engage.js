#!/usr/bin/env node
/**
 * facebook-group-engage.js — Reply to relevant threads + ask questions in member groups.
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/facebook-group-engage.js
 *
 * Ambassador voice: community member who switched to bamboo bedding. Helpful, no hard sell.
 * First engagement in a group: informational only. After 3+ replies: can mention bamboo naturally.
 * People who reply to our posts are saved as leads for Instagram cross-match.
 *
 * Required env vars:
 *   FB_SESSION_DIR   — persistent Facebook browser session path
 *   FB_GROUPS_FILE   — absolute path to facebook-groups.json
 *   LEADS_FILE       — absolute path to leads.json
 *   CLIENT_ID        — client identifier
 *
 * Optional env vars:
 *   PROXY            — proxy URL (required for UAE geo)
 *   OUTREACH_LOG     — path to outreach-log.ndjson
 *   SCREENSHOTS_DIR  — where to save screenshots (default: /tmp)
 *   MAX_REPLIES      — max replies per run (default: 5)
 *   MAX_QUESTIONS    — max original posts per run (default: 1)
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const FB_SESSION_DIR  = process.env.FB_SESSION_DIR  || '';
const FB_GROUPS_FILE  = process.env.FB_GROUPS_FILE  || '';
const LEADS_FILE      = process.env.LEADS_FILE      || '';
const CLIENT_ID       = process.env.CLIENT_ID       || '';
const PROXY           = process.env.PROXY || process.env.SOCIALPILOT_PROXY || '';
const OUTREACH_LOG    = process.env.OUTREACH_LOG    || '';
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/tmp';
const MAX_REPLIES     = parseInt(process.env.MAX_REPLIES   || '5', 10);
const MAX_QUESTIONS   = parseInt(process.env.MAX_QUESTIONS || '1', 10);

if (!FB_SESSION_DIR || !FB_GROUPS_FILE || !LEADS_FILE || !CLIENT_ID) {
  console.error('[fb-engage] ERROR: FB_SESSION_DIR, FB_GROUPS_FILE, LEADS_FILE, CLIENT_ID required');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── Reply templates (ambassador voice — Nada Ali, bamboo sleep advocate) ──────
// Pure information first — never pushy, never brand first
const INFO_REPLIES = [
  "I had the same issue — Dubai heat really affects sleep quality. What worked for me was switching to more breathable bedding, the moisture-wicking makes such a difference through the night",
  "The AC thing is real! Even with AC I used to wake up feeling hot. Turned out it was the bedding material more than the temperature. Natural fibres breathe so much better",
  "I'd look at the fabric rather than just thread count — synthetic blends trap heat badly here. Natural materials like bamboo or high-quality cotton make a noticeable difference in this climate",
  "Sleep quality here is genuinely different from back home — the humidity gets through everything. I found the biggest difference was bedding that actually wicks moisture rather than just feeling cool at first",
  "If it's the night sweats that are waking you, it's almost always the bedding. Most people don't realise how much of a difference the right material makes — especially in a humid climate like Dubai",
];

// Slightly warmer — can mention bamboo after 3+ engagements in a group
const WARM_REPLIES = [
  "I switched to bamboo sheets about a year ago and honestly it was the best home decision I've made here. The difference in how you sleep through the night is real — not just marketing",
  "Bamboo bedding changed everything for me in Dubai. Sounds like a gimmick but the temperature regulation is genuinely different — I stopped waking up overheated completely",
  "After trying everything — Egyptian cotton, microfibre — bamboo is the only thing that worked for the UAE climate long-term. Stays cool AND soft, which is harder to find than you'd think",
];

// Questions to post (once per group per week, generates engagement)
const GROUP_QUESTIONS = [
  "Anyone else find sleep quality drops in summer even with AC running? Curious what people have tried — I went through so many different things before finding what worked",
  "What's your biggest home comfort challenge in Dubai? For me it took a while to figure out the bedroom — the climate here really affects everything differently",
  "Has anyone found things that genuinely help with the heat at night here? Would love to know what's worked for people — still experimenting myself",
];

// Keywords that trigger a reply
const SLEEP_KEYWORDS = [
  'sleep', 'sheets', 'bedding', 'mattress', 'pillow', 'hot', 'heat', 'humid',
  'sweating', 'waking up', 'night sweat', 'insomnia', 'bedroom', 'duvet', 'duvet cover',
  'نوم', 'شراشف', 'مرتبة', 'وسادة', 'حر', 'تعرق', 'أرق', 'غرفة نوم', 'غطاء', 'مفرش',
];

function loadGroups() {
  try { return JSON.parse(fs.readFileSync(FB_GROUPS_FILE, 'utf8')); } catch { return []; }
}
function saveGroups(groups) {
  fs.writeFileSync(FB_GROUPS_FILE, JSON.stringify(groups, null, 2)); }

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

function isRelevantPost(text) {
  const lower = text.toLowerCase();
  return SLEEP_KEYWORDS.some(kw => lower.includes(kw));
}

function pickReply(group) {
  const postsReplied = group.posts_replied || 0;
  // Use warm replies (can mention bamboo) after 3+ prior engagements
  const pool = postsReplied >= 3 ? [...INFO_REPLIES, ...WARM_REPLIES] : INFO_REPLIES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickQuestion() {
  return GROUP_QUESTIONS[Math.floor(Math.random() * GROUP_QUESTIONS.length)];
}

for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(FB_SESSION_DIR, f)); } catch (e) { if (e.code !== 'ENOENT') {} }
}

(async () => {
  const groups = loadGroups();
  const memberGroups = groups.filter(g => g.status === 'member');

  if (!memberGroups.length) {
    console.log('[fb-engage] No member groups yet — run facebook-group-monitor.js first');
    process.exit(0);
  }

  console.log(`[fb-engage] ${memberGroups.length} member group(s) to work through`);

  const options = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
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
      console.error('[fb-engage] ERROR: Facebook session not logged in — stopping');
      await browser.close();
      process.exit(1);
    }
  } catch (e) {
    console.error('[fb-engage] ERROR loading Facebook:', e.message);
    await browser.close();
    process.exit(1);
  }

  let repliesPosted  = 0;
  let questionsAsked = 0;

  for (const group of memberGroups) {
    if (repliesPosted >= MAX_REPLIES && questionsAsked >= MAX_QUESTIONS) break;

    console.log(`\n[fb-engage] Processing group: ${group.group_name}`);

    try {
      await page.goto(group.group_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(4000);

      // Dismiss any popups
      try {
        const closeBtn = page.locator('[aria-label="Close"]').first();
        if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await closeBtn.click();
          await sleep(1000);
        }
      } catch {}

      // Scroll to load some posts
      for (let s = 0; s < 4; s++) {
        await page.evaluate(() => window.scrollBy(0, 600));
        await sleep(2000);
      }

      // ── Post a question if this group hasn't had one recently ─────────────
      const lastQuestionDays = group.last_question_at
        ? (Date.now() - new Date(group.last_question_at).getTime()) / 86400000
        : 999;

      if (questionsAsked < MAX_QUESTIONS && lastQuestionDays >= 7) {
        try {
          // Find the "Write something" box
          const writeBox = page.locator(
            '[data-testid="status-attachment-mentions-input"], ' +
            '[placeholder*="Write something"], ' +
            '[aria-label*="Write something"], ' +
            '[role="textbox"][aria-label*="Create"]'
          ).first();

          if (await writeBox.isVisible({ timeout: 5000 }).catch(() => false)) {
            const question = pickQuestion();
            await writeBox.click();
            await sleep(1500);
            await page.keyboard.type(question, { delay: rnd(40, 90) });
            await sleep(2000);

            // Click Post button
            const postBtn = page.locator(
              'div[aria-label="Post"], button[aria-label="Post"], div[role="button"]:has-text("Post")'
            ).first();
            if (await postBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
              await postBtn.click();
              await sleep(3000);

              group.questions_asked = (group.questions_asked || 0) + 1;
              group.last_question_at = new Date().toISOString();
              group.last_engaged_at  = new Date().toISOString();
              saveGroups(groups);

              logOutreach({
                platform: 'facebook_group',
                action:   'question_posted',
                group_url: group.group_url,
                group_name: group.group_name,
                text_snippet: question.substring(0, 80),
                client_id: CLIENT_ID,
              });

              console.log(`[fb-engage] ❓ Question posted in: ${group.group_name}`);
              questionsAsked++;
              await sleep(rnd(8000, 15000));
            }
          }
        } catch (e) {
          console.log(`[fb-engage] Could not post question in ${group.group_name}: ${e.message.slice(0, 80)}`);
        }
      }

      // ── Reply to relevant posts ───────────────────────────────────────────
      if (repliesPosted >= MAX_REPLIES) continue;

      const posts = await page.$$eval(
        '[role="article"]',
        els => els.slice(0, 15).map(el => ({
          text: el.querySelector('[data-ad-comet-preview="message"], [dir="auto"]')?.textContent?.trim() || '',
          postId: el.getAttribute('aria-posinset') || '',
        }))
      ).catch(() => []);

      console.log(`[fb-engage] Found ${posts.length} post articles`);

      for (let pi = 0; pi < posts.length && repliesPosted < MAX_REPLIES; pi++) {
        const post = posts[pi];
        if (!post.text || !isRelevantPost(post.text)) continue;

        console.log(`[fb-engage] Relevant post: "${post.text.substring(0, 60)}…"`);

        try {
          // Find comment box for this article
          const articles = await page.$$('[role="article"]');
          if (!articles[pi]) continue;

          // Click "Comment" link/button to open comment box
          const commentBtn = articles[pi].locator(
            '[aria-label*="Comment"], span:has-text("Comment"), div[role="button"]:has-text("Comment")'
          ).first();

          if (!await commentBtn.isVisible({ timeout: 3000 }).catch(() => false)) continue;
          await commentBtn.click();
          await sleep(2000);

          // Find the comment input
          const commentInput = articles[pi].locator('[role="textbox"], [contenteditable="true"]').first();
          if (!await commentInput.isVisible({ timeout: 4000 }).catch(() => false)) continue;

          const reply = pickReply(group);
          await commentInput.click();
          await sleep(1000);
          await page.keyboard.type(reply, { delay: rnd(40, 90) });
          await sleep(2000);

          // Submit with Enter
          await page.keyboard.press('Enter');
          await sleep(3000);

          await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `fb-engage-reply-${Date.now()}.png`) });

          group.posts_replied    = (group.posts_replied || 0) + 1;
          group.last_engaged_at  = new Date().toISOString();
          saveGroups(groups);

          logOutreach({
            platform:    'facebook_group',
            action:      'reply_posted',
            group_url:   group.group_url,
            group_name:  group.group_name,
            post_snippet: post.text.substring(0, 80),
            reply_snippet: reply.substring(0, 80),
            client_id:   CLIENT_ID,
          });

          // Save the post author as a lead for cross-matching
          try {
            const leads = loadLeads();
            // Try to get commenter username from the article
            const authorLink = await articles[pi].$('a[href*="facebook.com"]');
            const authorUrl  = authorLink ? await authorLink.getAttribute('href') : '';
            const authorName = authorLink ? await authorLink.textContent() : '';
            if (authorUrl && authorName && authorName.trim().length > 1) {
              const fbUsername = authorUrl.match(/facebook\.com\/([^/?#]+)/)?.[1] || authorName.trim().replace(/\s+/g, '.');
              const exists = leads.some(l => l.username === fbUsername && l.platform === 'facebook');
              if (!exists) {
                const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
                leads.push({
                  id: nextId,
                  username: fbUsername,
                  platform: 'facebook',
                  profile_url: authorUrl,
                  source_type: 'facebook_group_post',
                  source_handle: group.group_name,
                  total_score: 35,
                  engagement_stage: 0,
                  ig_checked: false,
                  notes: `Sleep question in FB group: ${group.group_name} | "${post.text.substring(0, 80)}"`,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  last_engaged_at: null,
                  is_do_not_engage: false,
                  coupon_referenced: 0,
                  coupon_code: null,
                  dm_pivot_attempted: 0,
                  dm_channel: null,
                });
                saveLeads(leads);
                console.log(`[fb-engage] Saved lead: ${fbUsername}`);
              }
            }
          } catch {}

          console.log(`[fb-engage] ✅ Reply posted in: ${group.group_name}`);
          repliesPosted++;
          await sleep(rnd(10000, 20000));
        } catch (e) {
          console.log(`[fb-engage] Reply error: ${e.message.slice(0, 80)}`);
        }
      }

    } catch (e) {
      console.error(`[fb-engage] ERROR on ${group.group_name}: ${e.message}`);
    }

    await sleep(rnd(5000, 10000));
  }

  await browser.close();
  console.log(`\n[fb-engage] Done. Replies: ${repliesPosted}, Questions: ${questionsAsked}`);
  process.exit(0);
})();
