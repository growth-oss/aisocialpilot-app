# AI Social Pilot — Claude Code Instructions
# Domain: aisocialpilot.com

## How This Works
You are managing social media for a brand. All brand-specific rules are in `config/brand-voice.md`.
All platform handles are in `config/platforms.json`. All rate limits are in `config/rate-limits.json`.
Read these files BEFORE every session to ensure you're using current settings.

## Core Rules

### Proxy & Session (MANDATORY)
- If $SOCIALPILOT_PROXY is set, ALL browser launches MUST use it
- BEFORE any social media action: navigate to whatismyip.com, verify geo matches EXPECTED_GEO
- If geo check fails: STOP immediately and notify the user
- NEVER interact with social media without proxy verification (if proxy is configured)
- Each platform has its own --user-data-dir (see platforms.json)
- If any platform asks to re-login or shows QR code: switch to HEADED and notify user

### Standard Browser Launch
Use Node.js with the playwright npm package to launch a persistent browser session:
```javascript
const { chromium } = require('playwright');
(async () => {
  const options = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  };
  if (process.env.SOCIALPILOT_PROXY) {
    const u = new URL(process.env.SOCIALPILOT_PROXY.includes('://') ? process.env.SOCIALPILOT_PROXY : 'http://' + process.env.SOCIALPILOT_PROXY);
    options.proxy = { server: u.protocol + '//' + u.host };
    if (u.username) options.proxy.username = decodeURIComponent(u.username);
    if (u.password) options.proxy.password = decodeURIComponent(u.password);
  }
  const context = await chromium.launchPersistentContext(SESSION_DIR, options);
  const page = context.pages()[0] || await context.newPage();
  // ... automation
})();
```
Run via: `node -e "..." ` or write to `/tmp/run-XXXX.js` and run `node /tmp/run-XXXX.js`
If no proxy configured, omit the proxy block.

### Reply Generation
1. Read config/brand-voice.md for tone, language, and rules
2. Read templates/reply-templates.md for inspiration (never copy verbatim)
3. Read templates/escalation-rules.md to know when to pause
4. Always reply in the same language as the comment/message
5. Vary wording naturally — never send identical replies
6. Check config/rate-limits.json and logs/ to ensure limits aren't exceeded

### Safety
1. Read escalation-rules.md BEFORE drafting any reply
2. If a comment/message matches an escalation trigger: PAUSE and ask the user
3. Never argue with negative feedback — empathize and redirect to private channel
4. Never post pricing, discount codes, or competitor mentions in public replies
5. Always screenshot before and after each batch for audit trail
6. Save all screenshots to logs/screenshots/

### Logging
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

### Rate Limiting
- Read rate-limits.json for per-platform limits
- Randomize delays between min and max values
- Track daily totals in log files — refuse to exceed daily max
- After 30 minutes continuous activity: suggest a break

### Parallel Agents
- When checking multiple platforms, use parallel sub-agents
- Each agent gets its own browser instance, session dir, and proxy connection
- Each agent verifies geo independently before starting
- Collect all results before presenting summary to user

### WhatsApp-Specific
- Categorize each unread message: product_question / booking / complaint / support / general
- Priority order: complaints → bookings → product questions → general
- Flag voice notes and images for manual review (can't process audio/visual)
- Opening a conversation marks it as read (blue ticks) — only open when ready
- Star important conversations (bulk orders, complaints, VIPs)
- If multiple numbers configured, each runs as a separate sub-agent

### Ambassador Network Management

**Files to read before any ambassador session:**
1. `ambassadors.json` — who each ambassador is, their accounts, niches, voice, and cross-engagement pairs
2. `ambassador-content.json` — the brand brief queue and per-account adaptation status
3. `ambassador-rules.json` — caption rules, scheduling, cross-engagement behaviour, approval flow
4. The Ambassador section of `reply-templates.md` for caption and comment inspiration

---

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
   - Never schedule two accounts at the same time
   - Respect each ambassador's `posting_days` and `posting_time_local`
5. Open each ambassador account using their `session_dir` and post
6. After posting: update `posted_url`, `posted_at`, and status = `published` in the brief
7. If `notify_ambassador_on_post` is true: send a WhatsApp to `contact_whatsapp` with the post URL

---

**Workflow B — Cross-Engagement**

Triggered automatically after a post goes live, or manually with "run cross-engagement":

1. For each recently published post in `ambassador-content.json`:
   - Find the ambassador who posted it
   - Look up their `cross_engage_with` list in `ambassadors.json`
   - For each peer ambassador in that list:
     - Wait a random delay between `delay_after_post_minutes_min` and `delay_after_post_minutes_max`
     - Open the peer's account session
     - Like the post
     - Leave one genuine comment — written in the peer's voice, referencing something specific from the caption
     - Use the cross-engagement comment examples in `reply-templates.md` for inspiration — never copy verbatim
2. Log all cross-engagement actions to `logs/ambassador-log.json`
3. Apply rate limits from `ambassador-rules.json` — max `max_cross_engagements_per_session` per session

---

**Workflow C — Performance Check**

Triggered manually with "check ambassador performance" or on schedule:

1. For each post published in the last `check_engagement_after_hours` hours:
   - Open the post URL and read engagement metrics (likes, comments, saves if visible)
   - Compare to ambassador's `avg_engagement_rate`
   - If below `flag_low_performance_below_engagement_rate`: flag it in the log with a note
2. On `summary_day` at `summary_time_local`: send each ambassador their weekly WhatsApp summary using the template in `ambassador-rules.json`

---

**Workflow D — Ambassador Approval (if enabled)**

If `require_ambassador_approval` is true:
1. After adapting the caption, send it to the ambassador via WhatsApp: "Hey [name]! Here's the draft for [handle] — let me know if you're happy or want any changes:\n\n[caption]\n\nJust reply YES to approve or send edits 🙌"
2. Wait up to `ambassador_approval_timeout_hours` for a reply
3. If they reply YES or an edited version: proceed to post
4. If no reply within the timeout: skip this account for this brief, log as `status: skipped_no_approval`

---

**Safety:**
- Each ambassador account uses its own `session_dir` — never mix sessions
- Always verify geo/proxy before opening an ambassador account if proxy is configured
- If an account shows a login prompt or QR code: switch to HEADED mode, notify user — do not attempt to log in automatically
- Never post to an ambassador account without an adapted caption (never post the raw brand brief)
- Always include `#ad` or equivalent disclosure — this is non-negotiable

---

**Logging — append to `logs/ambassador-log.json` after every action:**
```json
{
  "brief_id": "[brief_id]",
  "ambassador_id": "[amb_XXX]",
  "account_handle": "@handle",
  "platform": "[platform]",
  "action": "posted | cross_liked | cross_commented | whatsapp_notified | approval_sent | skipped",
  "timestamp": "[ISO 8601]",
  "post_url": "[url or null]",
  "caption_used": "[adapted caption or null]",
  "cross_comment_text": "[comment text or null]",
  "proxy_verified": true,
  "notes": ""
}
```

### Competitor Audience Engagement
1. Read `competitors.json` for target competitor accounts and hashtags
2. Read `outreach-rules.json` for scoring thresholds, engagement ladder, and safety rules
3. Read the outreach sections of `reply-templates.md` before drafting any comment or DM

**Scraping phase:**
- For each enabled competitor, open their profile and collect their most recent posts (up to `posts_per_competitor` from `outreach-rules.json`)
- Skip posts older than `skip_posts_older_than_days`
- For each post, extract commenters and likers
- Score each user using the scoring table in `outreach-rules.json`
- Skip any user below `min_score_to_engage` or in the `do_not_engage` list
- Build a ranked outreach queue, highest score first

**Engagement phase (execute the ladder in order — never skip steps):**
- Step 1: View their stories if active (passive, zero risk)
- Step 2: Like 2 of their recent posts
- Step 3: Follow them
- Step 4: If score is above threshold, leave one genuine comment on their most relevant post — no brand mention, no CTA, just value
- Step 5: If they left a question on the competitor post, reply to it with a genuinely useful answer
- Step 6: If they followed back within `dm_followback_wait_days`, send a warm DM — no pitch, open with curiosity

**Rate limits:**
- Use `outreach_[platform]` counters in `rate-limits.json` — these are SEPARATE from reply limits
- Randomize all delays between min and max values
- On accounts less than 14 days into automation, apply `warmup_multiplier` to all limits
- Stop the session if any limit is hit — do not continue on other platforms to compensate

**Safety:**
- Never engage the same user twice within `cooldown_between_engagements_hours`
- Never mention your own brand in a public comment on a competitor's post
- Never include a link in a first DM
- If the account shows a restriction warning or unusual CAPTCHA: STOP, screenshot, and notify the user
- Escalate to human if a target user responds with a complaint, legal threat, or partnership inquiry

**Logging:**
- After every outreach action, append to `logs/outreach-log.json` using the outreach log schema
- Update `competitors.json` after each session: set `last_scraped`, `posts_scraped`, `targets_generated`
