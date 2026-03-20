#!/usr/bin/env node
/**
 * youtube-comment.js — Comment on YouTube videos to build brand visibility.
 *
 * NEVER write this script from a Claude run — it is version-controlled.
 * Claude should call it with: node /app/server/scripts/youtube-comment.js
 *
 * Strategy: search YouTube for niche keywords → find recent videos with active
 * comment sections → leave genuine, value-adding comments that mention sleep
 * quality, bamboo, or bedding indirectly. No brand name, no links, no CTAs.
 * Goal is to appear as a knowledgeable person in the niche — curious viewers
 * click the profile, see the brand connection, and follow.
 *
 * Required env vars:
 *   GOOGLE_SESSION_DIR  — persistent browser session (must be logged in to Google)
 *   KEYWORDS            — JSON array of search strings e.g. '["bamboo bedding review","best mattress UAE"]'
 *   CLIENT_ID           — for logging
 *
 * Optional env vars:
 *   MAX_COMMENTS        — max comments to post total (default: 8)
 *   MAX_VIDEOS_PER_KW   — max videos to comment on per keyword (default: 3)
 *   DELAY_MIN           — min ms between comments (default: 45000 = 45s)
 *   DELAY_MAX           — max ms between comments (default: 120000 = 2min)
 *   OUTREACH_LOG        — path to outreach-log.ndjson
 *   COMMENT_LOG         — path to youtube-comment-log.json (tracks posted comments to avoid repeats)
 *   NICHE               — short description e.g. "bamboo bedding UAE" (used for comment tone)
 *   IS_AMBASSADOR       — "1" for ambassador/personal account tone
 */

'use strict';

const { chromium } = require('playwright');
const fs           = require('fs');

// ── Env vars ──────────────────────────────────────────────────────────────────
const GOOGLE_SESSION_DIR = process.env.GOOGLE_SESSION_DIR || '';
const CLIENT_ID          = process.env.CLIENT_ID || '';
const MAX_COMMENTS       = parseInt(process.env.MAX_COMMENTS || '8', 10);
const MAX_VIDEOS_PER_KW  = parseInt(process.env.MAX_VIDEOS_PER_KW || '3', 10);
const DELAY_MIN          = parseInt(process.env.DELAY_MIN || '45000', 10);
const DELAY_MAX          = parseInt(process.env.DELAY_MAX || '120000', 10);
const OUTREACH_LOG       = process.env.OUTREACH_LOG || '';
const COMMENT_LOG        = process.env.COMMENT_LOG || '';
const IS_AMBASSADOR      = process.env.IS_AMBASSADOR === '1';

let KEYWORDS = [];
try { KEYWORDS = JSON.parse(process.env.KEYWORDS || '[]'); } catch (e) {}

if (!GOOGLE_SESSION_DIR || !KEYWORDS.length) {
  console.error('[yt-comment] ERROR: GOOGLE_SESSION_DIR and KEYWORDS are required');
  process.exit(1);
}

// ── Comment pools ─────────────────────────────────────────────────────────────
// Indirect, value-first comments. No brand name, no links, no "check out X".
// Tone: knowledgeable person sharing genuine insight. Curious viewers click profile.

const EN_COMMENTS = [
  // Sleep/bedding knowledge
  "honestly the material makes such a difference — switched to natural fibres a while ago and the temperature regulation alone is worth it",
  "this is so underrated. most people don't realise how much bedding affects sleep quality, not just the mattress",
  "the moisture-wicking aspect is what gets overlooked the most. once you try it you can't go back to synthetic",
  "great video! the part about thread count being misleading is so true — weave type matters way more",
  "I've been saying this for years — invest in what you sleep ON, not just what you sleep under",
  "bamboo fibres are genuinely different from marketing claims. the breathability is real and measurable",
  "love that you mentioned temperature regulation — that's the #1 thing people with sleep issues get wrong",
  "this video should be required watching before anyone buys bedding honestly 😅",
  "the point about natural vs synthetic is spot on. your body knows the difference even if you don't consciously notice",
  "so glad someone is finally talking about this. sleep quality is such an underinvested area for most people",
  // UAE/region-specific
  "especially in this climate — breathable bedding isn't a luxury it's basically a necessity",
  "Gulf weather makes this even more relevant. anything that helps with night sweats is a game changer",
  "in a hot climate the right bedding can genuinely lower your room's needed AC temp — underrated saving",
  // Engagement hooks
  "what brand are you using in the video? curious to compare notes",
  "have you tried the bamboo vs eucalyptus comparison? would love to see that video",
  "do you have recommendations for where to source quality versions of this in the region?",
  "this is the kind of content that actually helps people make better decisions. subscribed 👍",
];

const AR_COMMENTS = [
  // Sleep/bedding knowledge
  "صراحة الخامة تفرق كثير — لما غيرت للألياف الطبيعية حسيت الفرق في درجة الحرارة فوراً",
  "هذا الموضوع مهم جداً وما يحصل الاهتمام اللي يستاهله. جودة النوم مرتبطة بالمفرش مش بس المرتبة",
  "الجانب المتعلق بامتصاص الرطوبة هو الأكثر إهمالاً. بعد ما تجربه ما تقدر ترجع للاصطناعي",
  "فيديو ممتاز! اللي قلته عن عدد الخيوط صح — نوع النسيج أهم بكثير من العدد",
  "أنا أقول هذا من سنين — استثمر في اللي تنام عليه مش بس فوقك",
  "ألياف البامبو مختلفة فعلاً — التهوية حقيقية وليست مجرد تسويق",
  "يعجبني إنك ذكرت تنظيم الحرارة — هذي أكثر نقطة يغلط فيها الناس عند شراء مفارش",
  "هذا الفيديو لازم كل شخص يشوفه قبل ما يشتري مفارش 😅",
  "الطبيعي مقابل الاصطناعي فرق كبير. جسمك يحس بالفرق حتى لو ما انتبهت",
  "شاكر على هذا المحتوى المفيد — النوم من أكثر المجالات اللي الناس ما تستثمر فيها",
  // UAE/region-specific
  "خصوصاً في هذا المناخ — المفارش المتنفسة مش رفاهية، ضرورة عملية",
  "في مناخ الخليج هذا الموضوع أهم بكثير. أي شيء يساعد في الليالي الحارة يستاهل",
  "المفرش الصح يقلل الحاجة للتكييف في الليل — توفير حقيقي ما يفكر فيه أحد",
  // Engagement hooks
  "أي ماركة استخدمت في الفيديو؟ أبي أقارن",
  "هل جربت مقارنة البامبو مع الإيكاليبتوس؟ يمكن فيديو ممتع",
  "عندك توصيات لمصادر جودة في المنطقة؟",
  "هذا النوع من المحتوى هو اللي يساعد الناس يتخذون قرارات أفضل. اشتركت 👍",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randDelay = () => delay(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Load comment log to avoid repeating same comment on same video
let commentLog = {};
if (COMMENT_LOG && fs.existsSync(COMMENT_LOG)) {
  try { commentLog = JSON.parse(fs.readFileSync(COMMENT_LOG, 'utf8')); } catch (e) {}
}

function saveCommentLog() {
  if (!COMMENT_LOG) return;
  try { fs.writeFileSync(COMMENT_LOG, JSON.stringify(commentLog, null, 2)); } catch (e) {}
}

function logOutreach(entry) {
  if (!OUTREACH_LOG) return;
  try { fs.appendFileSync(OUTREACH_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'); }
  catch (e) {}
}

function alreadyCommented(videoUrl) {
  return !!commentLog[videoUrl];
}

function markCommented(videoUrl, comment) {
  commentLog[videoUrl] = { comment, at: new Date().toISOString() };
  saveCommentLog();
}

// Detect if keyword/video context warrants Arabic comment
function shouldUseArabic(keyword, title) {
  const arSignals = ['uae', 'dubai', 'saudi', 'arab', 'gulf', 'خليج', 'دبي', 'السعودية', 'إمارات', 'مرتبة', 'نوم'];
  const combined = (keyword + ' ' + title).toLowerCase();
  return arSignals.some(s => combined.includes(s));
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[yt-comment] Starting for client ${CLIENT_ID}`);
  console.log(`[yt-comment] Keywords: ${KEYWORDS.join(', ')} | Max comments: ${MAX_COMMENTS}`);

  const launchOpts = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  };

  let context, page;
  try {
    context = await chromium.launchPersistentContext(GOOGLE_SESSION_DIR, launchOpts);
    page = context.pages()[0] || await context.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' });
  } catch (e) {
    console.error('[yt-comment] Browser launch failed:', e.message);
    process.exit(1);
  }

  let posted = 0;
  const usedComments = new Set(); // avoid exact repeats in same session

  for (const keyword of KEYWORDS) {
    if (posted >= MAX_COMMENTS) break;

    console.log(`[yt-comment] Searching: "${keyword}"`);

    try {
      // Search YouTube
      await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=CAISAhAB`, {
        waitUntil: 'domcontentloaded', timeout: 30000
      });
      await delay(3000 + Math.random() * 2000);

      // Collect video links from results
      const videoLinks = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a#video-title'));
        return anchors.slice(0, 10).map(a => ({
          url: 'https://www.youtube.com' + a.getAttribute('href'),
          title: a.textContent.trim()
        })).filter(v => v.url.includes('/watch?v='));
      });

      console.log(`[yt-comment] Found ${videoLinks.length} videos for "${keyword}"`);

      let kwComments = 0;
      for (const video of videoLinks) {
        if (posted >= MAX_COMMENTS || kwComments >= MAX_VIDEOS_PER_KW) break;
        if (alreadyCommented(video.url)) {
          console.log(`[yt-comment] Already commented on: ${video.title.slice(0, 50)}`);
          continue;
        }

        console.log(`[yt-comment] Opening: ${video.title.slice(0, 60)}`);
        await page.goto(video.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(4000 + Math.random() * 3000);

        // Scroll down to load comments
        await page.evaluate(() => window.scrollBy(0, 600));
        await delay(2000);
        await page.evaluate(() => window.scrollBy(0, 400));
        await delay(2000);

        // Check if comments are enabled — look for comment box
        const commentBox = page.locator('#simplebox-placeholder, ytd-commentbox #placeholder-area').first();
        const commentBoxVisible = await commentBox.isVisible({ timeout: 8000 }).catch(() => false);

        if (!commentBoxVisible) {
          console.log(`[yt-comment] Comments disabled or not loaded on: ${video.title.slice(0, 50)}`);
          continue;
        }

        // Click to activate comment box
        await commentBox.click();
        await delay(1500);

        // Pick a comment — avoid exact repeats
        const useAr = shouldUseArabic(keyword, video.title);
        const pool = useAr ? AR_COMMENTS : EN_COMMENTS;
        let comment;
        let attempts = 0;
        do {
          comment = pick(pool);
          attempts++;
        } while (usedComments.has(comment) && attempts < pool.length);
        usedComments.add(comment);

        // Type the comment
        const activeInput = page.locator('#contenteditable-root[contenteditable="true"]').first();
        if (!await activeInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          console.log(`[yt-comment] Input not visible for: ${video.title.slice(0, 50)}`);
          continue;
        }

        await activeInput.click();
        // Type with realistic delays
        for (const char of comment) {
          await page.keyboard.type(char);
          await delay(40 + Math.random() * 80);
        }
        await delay(1000 + Math.random() * 1000);

        // Click Submit button
        const submitBtn = page.locator('#submit-button[aria-label*="comment"], button[aria-label*="Comment"]').first();
        if (!await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          // Try pressing Ctrl+Enter
          await page.keyboard.press('Control+Enter');
        } else {
          await submitBtn.click();
        }
        await delay(2000);

        posted++;
        kwComments++;
        markCommented(video.url, comment);
        console.log(`[yt-comment] ✅ Posted on "${video.title.slice(0, 50)}": "${comment.slice(0, 60)}..."`);

        logOutreach({
          action_type: 'youtube_comment',
          platform: 'youtube',
          video_url: video.url,
          video_title: video.title,
          keyword,
          content_used: comment,
          result: 'posted',
          client_id: CLIENT_ID,
        });

        // Wait between comments — longer than Instagram to avoid detection
        if (posted < MAX_COMMENTS) {
          const waitMs = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
          console.log(`[yt-comment] Waiting ${Math.round(waitMs / 1000)}s before next comment...`);
          await delay(waitMs);
        }
      }

    } catch (err) {
      console.error(`[yt-comment] Error on keyword "${keyword}":`, err.message);
    }
  }

  await context.close();
  console.log(`[yt-comment] Done. Posted ${posted}/${MAX_COMMENTS} comments.`);
})();
