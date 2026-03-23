'use strict';
/**
 * youtube-reply.js — Reply to specific YouTube commenters from the Google/YouTube session.
 * NEVER write this script from a Claude run — it is version-controlled.
 * Call: node /app/server/scripts/youtube-reply.js
 *
 * Required: GOOGLE_SESSION_DIR, LEADS_FILE, CLIENT_ID
 * Optional: MAX_REPLIES (default 8), OUTREACH_LOG, DELAY_MIN (default 60000), DELAY_MAX (default 150000)
 */

const { chromium } = require('playwright');
const fs = require('fs');

const GOOGLE_SESSION_DIR = process.env.GOOGLE_SESSION_DIR || '';
const LEADS_FILE         = process.env.LEADS_FILE || '';
const CLIENT_ID          = process.env.CLIENT_ID || '';
const MAX_REPLIES        = parseInt(process.env.MAX_REPLIES || '8', 10);
const OUTREACH_LOG       = process.env.OUTREACH_LOG || '';
const DELAY_MIN          = parseInt(process.env.DELAY_MIN || '60000', 10);
const DELAY_MAX          = parseInt(process.env.DELAY_MAX || '150000', 10);

if (!GOOGLE_SESSION_DIR || !LEADS_FILE || !CLIENT_ID) {
  console.error('[yt-reply] ERROR: GOOGLE_SESSION_DIR, LEADS_FILE, and CLIENT_ID are required');
  process.exit(1);
}

const delay = ms => new Promise(r => setTimeout(r, ms));
const randDelay = () => delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));

const EN_REPLIES = [
  "that's such a good point 💯",
  "honestly the temperature regulation is the underrated part",
  "couldn't agree more — natural materials make such a difference for sleep",
  "this is exactly what I needed to hear, been thinking about switching for ages",
  "the breathability point is so real — especially in warmer climates",
  "have you noticed a difference with the sleep quality too? curious",
  "this is so underrated as a topic honestly",
  "100% — it took me switching to natural fibres to realise how much it matters",
  "the more I learn about this the more I wish I'd switched sooner",
  "so glad more people are talking about this ✨",
];

const AR_REPLIES = [
  "صح كلامك تماماً 💯",
  "جانب تنظيم الحرارة هذا دايم يُغفل عنه",
  "ما أقدر أتفق أكثر — الخامة الطبيعية تفرق فعلاً في النوم",
  "هذا اللي أحتاج أسمعه، أفكر أغير من فترة",
  "خصوصاً في المناخ الحار — الفرق واضح",
  "شفت فرق في جودة نومك كمان؟ أنا فضولي",
  "موضوع ما يحصل الاهتمام اللي يستاهله",
  "بعد ما جربت الطبيعي ما أقدر أرجع للاصطناعي",
  "يا ريت غيرت بدري 😅",
  "يسعدني إن الناس تبدأ تهتم بهذا الموضوع ✨",
];

function isArabic(text) {
  return /[\u0600-\u06FF]/.test(text || '');
}

function pickReply(commentText) {
  const pool = isArabic(commentText) ? AR_REPLIES : EN_REPLIES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function loadLeads() {
  try {
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch (e) {
    console.error('[yt-reply] ERROR reading leads file:', e.message);
    return [];
  }
}

function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function logOutreach(entry) {
  if (!OUTREACH_LOG) return;
  try {
    fs.appendFileSync(OUTREACH_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  } catch {}
}

(async () => {
  const leads = loadLeads();

  // Filter eligible leads
  const eligible = leads.filter(l =>
    l.platform === 'youtube' &&
    l.video_url &&
    l.engagement_stage === 0 &&
    l.comment_text &&
    l.comment_text.trim().length > 0 &&
    !l.yt_replied
  );

  console.log(`[yt-reply] ${eligible.length} eligible leads, will process up to ${MAX_REPLIES}`);

  if (eligible.length === 0) {
    console.log('[yt-reply] Nothing to do.');
    process.exit(0);
  }

  const toProcess = eligible.slice(0, MAX_REPLIES);

  // Launch browser — no proxy, YouTube blocks proxy
  const browser = await chromium.launchPersistentContext(GOOGLE_SESSION_DIR, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = browser.pages()[0] || await browser.newPage();

  // Verify YouTube session
  try {
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    console.log(`[yt-reply] YouTube loaded, title: "${title}"`);
    if (title.toLowerCase().includes('sign in')) {
      console.error('[yt-reply] ERROR: YouTube session requires login — stopping');
      await browser.close();
      process.exit(1);
    }
  } catch (e) {
    console.error('[yt-reply] ERROR loading YouTube:', e.message);
    await browser.close();
    process.exit(1);
  }

  let replied = 0;
  let skipped = 0;

  for (const lead of toProcess) {
    console.log(`\n[yt-reply] Processing @${lead.username} on video: ${lead.video_url}`);

    try {
      await page.goto(lead.video_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(4000);

      // Scroll down 3 times to load comments
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 600));
        await delay(1500);
      }

      // Wait for comment threads
      try {
        await page.waitForSelector('ytd-comment-thread-renderer', { timeout: 10000 });
      } catch {
        console.log(`[yt-reply]   Comments section not found — skipping`);
        skipped++;
        continue;
      }

      // Find the lead's comment by author name
      const threads = await page.$$('ytd-comment-thread-renderer');
      let targetThread = null;

      const normalizedUsername = lead.username.replace(/-/g, '').toLowerCase();

      for (const thread of threads) {
        const authorEl = await thread.$('#author-text');
        if (!authorEl) continue;
        const authorText = (await authorEl.textContent() || '').trim().toLowerCase();
        const authorNorm = authorText.replace(/-/g, '').replace(/\s+/g, '');
        const userNorm   = normalizedUsername.replace(/\s+/g, '');
        if (authorText.includes(lead.username.toLowerCase()) || authorNorm.includes(userNorm)) {
          targetThread = thread;
          break;
        }
      }

      if (!targetThread) {
        console.log(`[yt-reply]   Comment by @${lead.username} not found in visible comments — skipping`);
        skipped++;
        // Mark ig_checked so we don't retry forever
        const idx = leads.findIndex(l => l.username === lead.username && l.platform === 'youtube');
        if (idx !== -1) {
          leads[idx].updated_at = new Date().toISOString();
        }
        continue;
      }

      // Click Reply button on the thread
      const replyBtn = await targetThread.$('ytd-button-renderer button');
      if (!replyBtn) {
        console.log(`[yt-reply]   Reply button not found — skipping`);
        skipped++;
        continue;
      }

      await replyBtn.click();
      await delay(1500);

      const replyText = pickReply(lead.comment_text);
      console.log(`[yt-reply]   Replying: "${replyText}"`);

      // Type into the reply box (active element after clicking Reply)
      await page.keyboard.type(replyText, { delay: 40 });
      await delay(800);

      // Click submit
      const submitBtn = await targetThread.$('#submit-button');
      if (!submitBtn) {
        console.log(`[yt-reply]   Submit button not found — skipping`);
        skipped++;
        continue;
      }

      await submitBtn.click();
      await delay(2000);

      // Update lead
      const idx = leads.findIndex(l => l.username === lead.username && l.platform === 'youtube');
      if (idx !== -1) {
        leads[idx].yt_replied = true;
        leads[idx].engagement_stage = 1;
        leads[idx].updated_at = new Date().toISOString();
      }
      saveLeads(leads);

      logOutreach({
        platform: 'youtube',
        action: 'comment_reply',
        target_username: lead.username,
        video_url: lead.video_url,
        reply_text: replyText,
        status: 'posted',
        client_id: CLIENT_ID,
      });

      replied++;
      console.log(`[yt-reply]   Done. (${replied}/${MAX_REPLIES})`);

      if (replied < toProcess.length) {
        console.log(`[yt-reply]   Waiting before next reply...`);
        await randDelay();
      }
    } catch (e) {
      console.error(`[yt-reply]   ERROR on @${lead.username}:`, e.message);
      skipped++;
    }
  }

  await browser.close();

  console.log(`\n[yt-reply] Summary: ${replied} replied, ${skipped} skipped`);
  process.exit(0);
})();
