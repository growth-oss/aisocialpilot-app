# AI Social Pilot — Claude Code Instructions
# Domain: aisocialpilot.com

---

## ⚡ NEW SESSION ORIENTATION

If this is a new chat session, read this first.

**What this project is:** A self-hosted social media automation + lead generation platform deployed on Railway (Docker). Admin panel at `/`, client detail page at `/client.html?id=XXX`.

**Project location:** `/Users/S7/Library/CloudStorage/GoogleDrive-claudescrappy@gmail.com/Shared drives/Claude/SocialAIAutomation/`

**Live app:** https://aisocialpilot-app-production.up.railway.app/ (auto-deploys on `git push origin main`)

**Real files to work with:**
- `server/index.js` — Express server, all API routes
- `server/leadgen/prompt.js` — Claude automation prompt builder
- `server/leadgen/db.js` — leads JSON data store
- `admin/public/index.html` — all-clients dashboard SPA
- `admin/public/client.html` — client detail page (sidebar + Claude chat panel + Content tab)
- `data/clients/{id}/leadgen/precision-briefs.json` — Precision Content briefs storage

**Do NOT edit:** root `index.js`, root `index.html`, `PROJECT_PLAN.md` — all outdated

**Current client:** Bamboo Sleep Professor / DrSleeep bamboo bedding UAE. Ambassador: Nada Ali (@bamboo_sleep_professor). ~36 leads in pipeline at stages 3–4.

**For full project context:** Read `.claude/MEMORY.md`

---

## How This Works (Automation Runs)
Brand-specific rules are in `config/brand-voice.md`.
Platform handles are in `config/platforms.json`. Rate limits are in `config/rate-limits.json`.
Read these files BEFORE every automation session.

## Core Rules

### Autonomous Operation (CRITICAL)
- You are running in **non-interactive automated mode** — there is no user to respond to mid-run
- **NEVER ask for permission or confirmation** mid-run — make decisions and proceed
- If headless mode fails for dynamic content: automatically switch to headed mode and continue
- If you encounter a recoverable error: try the next approach, don't stop and ask
- Only stop for: login required, proxy geo mismatch, unrecoverable errors

### Proxy & Session (MANDATORY)
- If $SOCIALPILOT_PROXY is set, ALL browser launches MUST use it
- BEFORE any social media action: verify geo via:
  ```
  curl -s -x "$SOCIALPILOT_PROXY" --max-time 20 --connect-timeout 15 https://ipinfo.io/json
  ```
  Check "country" field matches EXPECTED_GEO.
  **Do NOT use whatismyip.com or any browser-based geo check** — too slow in headless, times out
- If geo check fails: STOP and log the error (do not proceed)
- NEVER interact with social media without proxy verification (if proxy is configured)
- Each platform has its own --user-data-dir:
  **Session dirs are at `{DATA_DIR}/clients/{CLIENT_ID}/browser-sessions/{platform}/`**
  NOT `sessions/{platform}/` — that old path is wrong
- If any platform asks to re-login or shows QR code: STOP and log (do not attempt login)
- If Chrome session lock conflict (`SingletonLock` error): delete the lock file and retry once

### Standard Browser Launch
**ALWAYS use headed mode (headless: false)** — the container has a virtual Xvfb display on DISPLAY=:99.

```javascript
const { chromium } = require('playwright');
(async () => {
  const options = {
    headless: false,  // ALWAYS headed — never change this
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  };
  if (process.env.SOCIALPILOT_PROXY) {
    const u = new URL(process.env.SOCIALPILOT_PROXY.includes('://') ? process.env.SOCIALPILOT_PROXY : 'http://' + process.env.SOCIALPILOT_PROXY);
    options.proxy = { server: u.protocol + '//' + u.host };
    if (u.username) options.proxy.username = decodeURIComponent(u.username);
    if (u.password) options.proxy.password = decodeURIComponent(u.password);
  }
  const SESSION_DIR = `${process.env.DATA_DIR}/clients/${process.env.CLIENT_ID}/browser-sessions/${platform}`;
  const context = await chromium.launchPersistentContext(SESSION_DIR, options);
  const page = context.pages()[0] || await context.newPage();
  // ... automation
})();
```
Write to `/tmp/run-XXXX.js` and run `node /tmp/run-XXXX.js`

### Lead Gen — Writing to leads.json
Use the server API to upsert leads — **do NOT write leads.json directly** from Claude:
```
POST http://localhost:3000/api/clients/{CLIENT_ID}/leadgen/leads  (internal only during runs)
```
Or use the Claude tool calls that the prompt.js generates — leads are written via db.js functions.

Actually: Claude writes leads.json directly using the Write/Edit tools. Follow the schema in MEMORY.md exactly. Use `??` not `||` for nullish checks in JS.

### Cooldown Check (CRITICAL BUG FIX)
When checking cooldown in JS config:
```javascript
// CORRECT:
const cooldownHours = cfg.pipeline?.cooldown_between_engagements_hours ?? 48;
// WRONG (0 becomes 48 because 0 is falsy):
const cooldownHours = cfg.pipeline?.cooldown_between_engagements_hours || 48;
```

### Meta Ads Library (SPECIAL HANDLING)
Meta Ads Library is a React SPA — you **cannot** extract Instagram post URLs from the DOM directly.
**Correct approach:**
1. Search by keyword (e.g. "mattress", "bedding", "مرتبة") with country=AE filter
2. Extract advertiser BRAND NAMES from the page
3. Search Instagram for those brand names to find their handles
4. Scrape their last 20 posts for commenters/likers
5. Set source_type = "competitor_ad_commenter", score +40
6. Save discovered competitors to hot-sources.json for future runs

### Source Geo Targeting
For competitor scraping: some competitors are international and run ads for multiple countries. Always search Meta Ads Library with the geo from the CLIENT config (`target_geo` field), not a hardcoded country.

---

## Lead Gen Sources — Adding a New Source

To add a new platform as a lead source:

**1. Add to hot-sources.json** (via admin UI or direct file edit):
```json
{
  "platform": "google_maps",
  "type": "keyword",
  "handle_or_url": "luxury bedding Dubai",
  "enabled": true,
  "why": "Business owners who buy bedding in bulk"
}
```

**2. Source types Claude handles:**
- `type: "account"` — scrape posts/commenters from a specific account
- `type: "hashtag"` — scrape posts with this hashtag
- `type: "location"` — scrape posts tagged at this location
- `type: "keyword"` — search-based scraping (Google Maps, Google Search, Dubizzle, etc.)
- `type: "meta_ads"` — Meta Ads Library keyword discovery (see special handling above)

**3. Platform-specific session dirs:**
- instagram → `browser-sessions/instagram/`
- facebook → `browser-sessions/facebook/`
- linkedin → `browser-sessions/linkedin/`
- tiktok → `browser-sessions/tiktok/`
- google → `browser-sessions/google/` (covers YouTube, Google Maps, Google Search — optional, public scraping works without login)
- dubizzle → no session needed (public)

**4. New platforms need:**
- Session login (if required) via admin UI → Login button → VNC browser
- Rate limits added to `config/rate-limits.json`
- Optional: platform-specific scraping logic in `server/leadgen/prompt.js`

---

## Per-Source Quick Reference

### Instagram (Working ✅)
- Session: `browser-sessions/instagram/`
- Proxy: required (AE)
- Sources: competitor accounts, hashtags, location posts
- Daily limits: check `rate-limits.json` (typically 50 follows, 100 likes, 20 DMs)
- Known issue: stories require being logged in; story views count toward warmup

### Facebook (TODO 🔧)
- Session: `browser-sessions/facebook/`
- Sources: groups (home decor UAE), pages, marketplace
- Note: Group scraping requires group membership
- Rate limits: conservative (Facebook detects automation aggressively)

### LinkedIn (TODO 🔧)
- Session: `browser-sessions/linkedin/`
- Sources: search by title (Interior Designer, Procurement Manager) + location UAE
- Profile URL pattern: `linkedin.com/in/...`
- Scraping: search results page, extract profile cards
- DM: "InMail" or Connect request with note
- Rate limits: 20 connects/day max (strict)

### TikTok (TODO 🔧)
- Session: `browser-sessions/tiktok/`
- Sources: hashtag pages (#UAEhome, #دبي_ديكور), video commenters
- Note: TikTok heavily blocks automation — use low limits, long delays

### Google Maps (TODO 🔧)
- Session: none (public)
- Sources: keyword search → business listings
- Extract: business name, website, phone (if visible), category
- Score: +30 for hotel/resort (bulk buyer), +20 for interior design firm
- Lead profile: use business name as username, set platform = "google_maps"

### Dubizzle (TODO 🔧)
- Session: none (public)
- Sources: furnished apartment/villa listings → sellers are home furnishing buyers
- URL: `dubizzle.com/for-rent/properties/...?furnished=true`
- Extract: listing poster name, contact reference
- Score: furnished listings = high intent

### Pinterest (TODO 🔧)
- Session: optional (public browsing available)
- Sources: search boards/pins for "bamboo bedding", "luxury bedroom UAE"
- Extract: pinner profiles who save bedding content

### YouTube (Working ✅)
- Session: none needed (public comments, no login required)
- Source types: `keyword` (YouTube search → video commenters), `account` (specific channel → video commenters)
- Scrapes top 10 videos per source, extracts 20-30 commenters per video
- Scoring: keyword commenter +25, channel commenter +30, purchase signal in comment +15
- source_types: `youtube_video_commenter`, `youtube_channel_commenter`
- Discovery only — leads enter at stage 0, advance via cross-platform match (Instagram) or external DM
- No proxy/geo required (public content)

### Quora (TODO 🔧)
- Session: none needed for public content
- Sources: questions about sleep quality, best bedding UAE
- Extract: question askers + answerers

### Google Search (TODO 🔧)
- No browser session needed
- Sources: organic search for "bamboo bedding UAE buy" → extract landing page visitors is NOT possible
- Alternative: scrape Google Business listings, blog comment sections
- Or: identify which blogs/sites rank → scrape their comment sections

---

## Reply Generation
1. Read config/brand-voice.md for tone, language, and rules
2. Read templates/reply-templates.md for inspiration (never copy verbatim)
3. Read templates/escalation-rules.md to know when to pause
4. Always reply in the same language as the comment/message
5. Vary wording naturally — never send identical replies
6. Check config/rate-limits.json and logs/ to ensure limits aren't exceeded

## Safety
1. Read escalation-rules.md BEFORE drafting any reply
2. If a comment/message matches an escalation trigger: PAUSE and ask the user
3. Never argue with negative feedback — empathize and redirect to private channel
4. Never post pricing, discount codes, or competitor mentions in public replies
5. Always screenshot before and after each batch for audit trail → `logs/screenshots/`

## Logging
After each reply/action, append to the platform's log file in logs/:
```json
{
  "platform": "[platform]",
  "timestamp": "[ISO 8601]",
  "target": "[post URL or conversation ID]",
  "original_text": "[what they said]",
  "our_reply": "[what we said]",
  "category": "[product_question|complaint|positive|booking|general]",
  "status": "[posted|sent|escalated|skipped]",
  "delay_ms": [actual delay used],
  "proxy_verified": [true|false],
  "auto_mode": [true|false]
}
```

## Rate Limiting
- Read rate-limits.json for per-platform limits
- Randomize delays between min and max values
- Track daily totals in log files — refuse to exceed daily max
- After 30 minutes continuous activity: suggest a break

## Parallel Agents
- When checking multiple platforms, use parallel sub-agents
- Each agent gets its own browser instance, session dir, and proxy connection
- Each agent verifies geo independently before starting
- Collect all results before presenting summary to user

## WhatsApp-Specific
- Categorize each unread message: product_question / booking / complaint / support / general
- Priority order: complaints → bookings → product questions → general
- Flag voice notes and images for manual review (can't process audio/visual)
- Opening a conversation marks it as read (blue ticks) — only open when ready
- Star important conversations (bulk orders, complaints, VIPs)

---

## Precision Content Engine

Triggered when `command = 'precision-post:{briefId}'` is passed to the automation run.

### What it is
Reverse marketing: instead of posting and hoping the right people see it, we cluster existing pipeline leads by pain point → generate a targeted brief → create Gemini images → post via the brand ambassador → amplify by tagging and DMing specific leads.

### Data
- Briefs stored in `{DATA_DIR}/clients/{CLIENT_ID}/leadgen/precision-briefs.json`
- Generated images stored in `{DATA_DIR}/clients/{CLIENT_ID}/assets/precision/{briefId}.png`
- Brief schema fields: `id`, `cluster_topic`, `format` (carousel/reel/post/story/dm_only), `content_brief`, `image_prompt`, `tagging_instructions`, `dm_sequence[]`, `leads[]`, `image_url`, `status` (draft/approved/rejected/posted)

### When command = `precision-post:{briefId}`

1. **Read the brief**
   - Load `precision-briefs.json`, find the brief by `briefId`
   - Verify `status === 'approved'` — if not, log error and stop
   - Read `config/brand-voice.md` for tone and visual identity

2. **Check image**
   - If `image_url` is set: the image file exists at `{DATA_DIR}/clients/{CLIENT_ID}/assets/precision/{briefId}.png`
   - If no image: proceed anyway (post caption only, or story without image)

3. **Post the content**
   - Open the ambassador Instagram account (`browser-sessions/instagram/`)
   - Verify proxy geo (AE) before opening session
   - Based on `format`:
     - `carousel`: create multi-image post (use the generated image as first frame, add text overlays for subsequent frames)
     - `reel`: note in log that reel upload requires manual — post as carousel instead
     - `post`: single image post
     - `story`: story upload
     - `dm_only`: skip posting, go straight to DM step
   - Caption: use `content_brief` as the full caption (it already includes hashtags and CTA from brief generation)
   - Apply tagging from `tagging_instructions`:
     - `reply_tag`: after posting, comment on recent posts by the tagged accounts mentioning them
     - `caption_ref`: already included in caption

4. **Amplification — DM sequence**
   - For each lead in `brief.leads[]`:
     - Check the lead's `engagement_stage` — only DM if stage >= 3 (followed)
     - Send DM step 1 from `dm_sequence[0]`
     - Update lead's `engagement_stage` to 5 (DM sent) in `leads.json`
     - Log to `outreach-log.ndjson`
   - Respect cooldown: `cooldown_between_engagements_hours` from `leadgen-config.json`
   - Apply daily DM rate limit from `rate-limits.json`

5. **Update brief status**
   - Set `status = 'posted'`, `posted_at = ISO timestamp`, `post_url = URL of post`
   - Save back to `precision-briefs.json`

6. **Log**
   - Append to `logs/outreach-log.json` for each action taken
   - Write summary to run log

### Visual Identity Rules (apply to all image prompts)
- Person in bed/bedroom: Emirati woman, hair wrapped in white towel, plush white bathrobe
- Setting: UAE apartment/villa — marble surfaces, neutral linen tones, warm natural light
- Mood: calm luxury, morning routine, aspirational
- Text overlays: bilingual EN+AR, RTL Arabic, <20% of image area
- Never generate: Western/non-Emirati women, stock photo look, cluttered rooms

---

## Ambassador Network Management

**Files to read before any ambassador session:**
1. `ambassadors.json` — who each ambassador is, their accounts, niches, voice, cross-engagement pairs
2. `ambassador-content.json` — the brand brief queue and per-account adaptation status
3. `ambassador-rules.json` — caption rules, scheduling, cross-engagement behaviour, approval flow
4. The Ambassador section of `reply-templates.md` for caption and comment inspiration

**Workflow A — Adapt & Schedule a Brief**

Triggered when user says "publish brief [brief_id]" or "run ambassador session":

1. Load the brief from `ambassador-content.json` where status = `approved`
2. For each entry in `target_accounts`:
   - Load the ambassador's account from `ambassadors.json` using `ambassador_id`
   - Read their `voice_notes`, `niche`, `topics`, and `posting_days`/`posting_time_local`
   - Check if the ambassador has already posted today — if yes, skip and log
   - Rewrite the `brand_core_message` entirely in their voice, for their niche angle
   - Respect `caption_length_guide` from `ambassador-rules.json`
   - Append brand hashtags + disclosure text at the end
   - Save the adapted caption into `adapted_caption` in the brief
3. If `require_caption_approval_before_posting` is true: present ALL adapted captions to user for review before posting anything
4. Once approved, schedule each post within the `publish_window`, staggered by `stagger_posts_minutes_min/max`
5. Open each ambassador account using their `session_dir` and post
6. After posting: update `posted_url`, `posted_at`, status = `published`
7. If `notify_ambassador_on_post` is true: send WhatsApp to `contact_whatsapp` with post URL

**Workflow B — Cross-Engagement**

1. For each recently published post, find the ambassador and their `cross_engage_with` peers
2. Each peer: wait random delay, open their session, like the post, leave one genuine comment in their voice
3. Log to `logs/ambassador-log.json`
4. Apply rate limits from `ambassador-rules.json`

**Safety:**
- Each ambassador account uses its own `session_dir` — never mix sessions
- Always verify geo/proxy before opening an ambassador account
- Never post raw brand brief — always adapt to ambassador voice
- Always include `#ad` or equivalent disclosure — non-negotiable

---

## Competitor Audience Engagement

1. Read `competitors.json` for target competitor accounts and hashtags
2. Read `outreach-rules.json` for scoring thresholds, engagement ladder, and safety rules

**Engagement ladder (execute in order — never skip steps):**
- Step 1: View their stories
- Step 2: Like 2 recent posts
- Step 3: Follow
- Step 4: Leave genuine comment (no brand mention, no CTA)
- Step 5: Reply to any question they left on competitor post
- Step 6: If followed back within `dm_followback_wait_days`: send warm DM (no pitch, open with curiosity)

**Safety:**
- Never mention your own brand in a public comment on a competitor's post
- Never include a link in a first DM
- Cooldown: never engage same user twice within `cooldown_between_engagements_hours`
- If restriction warning or unusual CAPTCHA: STOP and notify user

**Logging:** append to `logs/outreach-log.json`; update `competitors.json` after session
