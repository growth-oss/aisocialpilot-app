'use strict';
// ─── Lead Gen — Runtime Prompt Builder ───────────────────────────────────────
// Generates the Claude prompt for a lead gen automation run.
// Embeds all client config so Claude has full context without reading extra files.

const fs   = require('fs');
const path = require('path');

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function buildLeadGenPrompt(clientConfig, dataDir) {
  const clientId  = clientConfig.clientId;
  const clientDir = path.join(dataDir, 'clients', clientId);
  const lgDir     = path.join(clientDir, 'leadgen');

  // Read all leadgen config
  const cfg      = readJson(path.join(lgDir, 'leadgen-config.json'), {});
  const sources  = readJson(path.join(lgDir, 'hot-sources.json'), []);
  const personas = readJson(path.join(lgDir, 'personas.json'), []);
  const coupons  = readJson(path.join(lgDir, 'coupon-config.json'), {});

  // Rate limits (pull from client's rate-limits.json if present, fall back to safe defaults)
  const rl       = readJson(path.join(clientDir, 'config', 'rate-limits.json'), {});
  const maxLikes  = rl.outreach_instagram?.max_likes_per_session   || rl.outreach?.max_likes_per_session   || 30;
  const maxFollows= rl.outreach_instagram?.max_follows_per_session || rl.outreach?.max_follows_per_session || 20;
  const maxDMs    = rl.outreach_instagram?.max_dms_per_session     || rl.outreach?.max_dms_per_session     || 10;
  const maxLeads  = rl.outreach?.max_leads_per_session || 20;
  const delayMin  = rl.outreach?.delay_between_actions_ms?.min || 3000;
  const delayMax  = rl.outreach?.delay_between_actions_ms?.max || 8000;

  // Brand voice file (inject snippet so Claude doesn't need to read a separate file)
  let brandVoice = '';
  try {
    const bvPath = path.join(clientDir, 'config', 'brand-voice.md');
    if (fs.existsSync(bvPath)) brandVoice = fs.readFileSync(bvPath, 'utf8').slice(0, 800);
  } catch {}

  // Current pipeline snapshot for context
  const leads    = readJson(path.join(lgDir, 'leads.json'), []);
  const active   = leads.filter(l => !l.is_do_not_engage);
  const maxId    = leads.reduce((m, l) => Math.max(m, l.id || 0), 0);
  const pipelineSnap = {
    total:      active.length,
    maxId,
    byStage:    [0,1,2,3,4,5,6].map(s => ({ stage: s, count: active.filter(l => l.engagement_stage === s).length })),
    hot:        active.filter(l => l.total_score >= (cfg.thresholds?.min_score_for_dm || 60)).length,
    converted:  leads.filter(l => l.is_converted).length,
  };

  const enabledSources  = sources.filter(s => s.enabled);
  const enabledPersonas = personas.filter(p => p.enabled);
  const activeCoupons   = (coupons.active_coupons || []).filter(c => c.enabled);

  // Paths
  const leadsJsonPath     = path.join(lgDir, 'leads.json');
  const logNdjsonPath     = path.join(lgDir, 'outreach-log.ndjson');
  const screenshotsDir    = path.join(clientDir, 'logs', 'screenshots');

  // Purchase intent signals
  const PURCHASE_SIGNALS = [
    'price', 'how much', 'where to buy', 'link', 'discount', 'promo', 'order', 'shipping',
    'available', 'stock', 'buy', 'purchase', 'cost', 'worth it', 'recommend',
    'كم السعر', 'كيف أشتري', 'وين أحصل', 'مكان الشراء', 'سعر', 'طلب',
  ];

  return `You are running a FULLY AUTONOMOUS lead generation session for the brand "${clientConfig.name}".
Do NOT ask for confirmation. Do NOT pause. Make decisions and proceed.
Only stop for: login required, proxy geo mismatch, account restriction warning.

━━━ ENVIRONMENT ━━━
Client ID:   ${clientId}
Leads file:  ${leadsJsonPath}
Action log:  ${logNdjsonPath}
Screenshots: ${screenshotsDir}
Current max lead ID in file: ${maxId}  ← next new lead ID = ${maxId + 1}, then ${maxId + 2}, etc.
Proxy: ${clientConfig.proxy?.url ? 'configured' : 'none'}
Expected geo: ${clientConfig.proxy?.geo || 'any'}

━━━ BRAND VOICE (read before writing any comment or DM) ━━━
${brandVoice || 'No brand-voice.md found — use a helpful, genuine, non-promotional tone.'}

━━━ BRAND CONTEXT ━━━
WhatsApp: ${cfg.brand?.whatsapp_number || 'not set'}
Website:  ${cfg.brand?.website_url || 'not set'}
DM CTA:   "${cfg.brand?.dm_cta || 'Send us a DM for details'}"
Promo active: ${cfg.brand?.promo_active ? 'YES — urgency language ALLOWED' : 'no — do not use urgency'}
${cfg.brand?.promo_ends_at ? `Promo ends: ${cfg.brand.promo_ends_at}` : ''}
Niche keywords: ${(cfg.niche_keywords || []).join(', ')}

━━━ SCORING RULES ━━━
Apply these point values when evaluating each discovered user:
${JSON.stringify(cfg.scoring || {}, null, 2)}

Thresholds:
- Min score to engage at all:  ${cfg.thresholds?.min_score_to_engage || 20}
- Min score for comment:       ${cfg.thresholds?.min_score_for_comment || 40}
- Min score for DM:            ${cfg.thresholds?.min_score_for_dm || 60}
- Min score to share coupon:   ${cfg.thresholds?.min_score_for_coupon || 70}
- Influencer threshold:        ${cfg.thresholds?.influencer_min_followers || 5000} followers

━━━ INFLUENCER FAST-TRACK ━━━
If follower_count ≥ ${cfg.thresholds?.influencer_min_followers || 5000} → mark is_influencer = 1.
Influencers skip stages 1-3 (story view, likes, follow) and go directly to:
  Stage 4: Leave a thoughtful comment referencing something specific in their content.
  Stage 6: DM immediately — open with genuine admiration for their content, mention the brand
           only if they engage back. Offer a free product or exclusive collab, NOT a discount code.
Do not use the standard coupon with influencers — flag them in notes for manual follow-up.

━━━ PIPELINE RULES ━━━
- Cooldown: ${cfg.pipeline?.cooldown_between_engagements_hours || 48}h between touching the same user
- Follow-back wait before DM:  ${cfg.pipeline?.dm_followback_wait_days || 3} days
- Warmup period: ${cfg.pipeline?.warmup_days || 14} days → apply ${cfg.pipeline?.warmup_multiplier || 0.5}x to all rate limits

━━━ RATE LIMITS (this session) ━━━
Max leads to process: ${maxLeads}
Max likes:   ${maxLikes}
Max follows: ${maxFollows}
Max DMs:     ${maxDMs}
Delay between actions: ${delayMin}-${delayMax} ms (randomise within range)
Delay between profiles: 30-90 seconds (randomise)
STOP the session if any limit is hit — do not exceed.

━━━ CURRENT PIPELINE SNAPSHOT ━━━
Total leads: ${pipelineSnap.total}
Stage breakdown: ${pipelineSnap.byStage.map(s => `Stage${s.stage}=${s.count}`).join(', ')}
Hot leads ready for DM: ${pipelineSnap.hot}
Converted: ${pipelineSnap.converted}
Next lead ID to use: ${maxId + 1}

━━━ HOT SOURCES TO SCRAPE (${enabledSources.length} enabled) ━━━
${enabledSources.map(s => `- [${s.platform}] ${s.source_type}: ${s.handle_or_tag}  (last scraped: ${s.last_scraped_at || 'never'}, posts: ${s.posts_scraped || 0})`).join('\n') || 'No sources configured — add competitor handles and hashtags in the Lead Gen → Sources tab.'}

━━━ PERSONAS (${enabledPersonas.length} available) ━━━
${enabledPersonas.map(p => `ID: ${p.id}
  Name: ${p.name}  |  Platforms: ${(p.platforms || []).join(', ')}
  Voice: ${p.voice}
  Comment openers: ${(p.comment_openers || []).join(' / ')}
  DM opening: ${p.dm_voice}
  Bio: ${p.bio_template || '—'}`).join('\n\n') || 'No personas configured.'}

Persona selection: match persona platform list to the target platform. If multiple match, pick the one
whose voice fits the target's profile best. Never switch personas mid-session for the same lead.

━━━ COUPON CONFIG ━━━
${activeCoupons.length ? activeCoupons.map(c =>
  `Code: ${c.code}  |  "${c.label}"  |  Min score: ${c.min_lead_score}  |  Platforms: ${(c.platforms || []).join(', ')}`
).join('\n') : 'No active coupons — skip coupon step.'}

Coupon DM template (fill in placeholders before sending):
"${coupons.dm_coupon_template || 'Hey {name}! Use code {code} for {label}: {website_url}'}"
Placeholders: {name} = display_name or username, {code} = coupon code,
              {label} = coupon label, {website_url} = ${cfg.brand?.website_url || 'website'}
${coupons.attribution?.track_utm ? `Add UTM: ?utm_source=${coupons.attribution.utm_source}&utm_medium=${coupons.attribution.utm_medium}&utm_campaign=${coupons.attribution.utm_campaign}` : ''}

━━━ PURCHASE INTENT SIGNALS ━━━
If a lead's public comments, replies, or bio contain ANY of these words/phrases, they have high purchase
intent — prioritise them for DM and include WhatsApp pivot:
${PURCHASE_SIGNALS.map(s => `"${s}"`).join(', ')}

━━━ THE 6-STEP ENGAGEMENT LADDER ━━━
Execute steps in order. Each step updates the lead's engagement_stage + last_engaged_at in leads.json.

STEP 1 — Story View → stage 1
  View their active stories if any. Zero risk, purely passive. Skip if no active stories.

STEP 2 — Like → stage 2
  Like their 2 most recent posts. Random delay between likes.

STEP 3 — Follow → stage 3
  Follow their account.

STEP 4 — Comment → stage 4  (only if score ≥ ${cfg.thresholds?.min_score_for_comment || 40})
  Leave ONE genuine comment on their most relevant post.
  Select a comment opener from the active persona. Write naturally in that persona's voice.
  NEVER mention the brand. NEVER include a CTA. Under 20 words. Sound human.
  Save comment text to outreach log content_used field.

STEP 5 — Reply to question → stage 5
  If they posted a question on the competitor post: reply with a genuinely helpful answer.
  Still no brand mention. Goal: build credibility and get on their radar.

STEP 6 — DM → stage 6  (only if score ≥ ${cfg.thresholds?.min_score_for_dm || 60} AND followed back)
  Send a warm, curiosity-driven opening DM in the persona's voice.
  NO pitch. NO links. Open with something specific from their profile or a recent post.
  If they respond positively: follow up with the brand context and (if eligible) coupon.
  DM pivot: if purchase intent signals detected → "Would it be easier to chat on WhatsApp?
  Here's the number: ${cfg.brand?.whatsapp_number || '[WhatsApp number]'}"

━━━ DATA SCHEMAS ━━━

leads.json — read the full array first, upsert/add entries, write the complete array back atomically.
To generate a new ID: use (current max ID in array) + 1, then +1 again for each subsequent new lead.

Each lead object:
{
  "id":                 <integer — max existing id + 1 for new leads>,
  "platform":           "<instagram|tiktok|x|whatsapp>",
  "username":           "<handle without @>",
  "profile_url":        "<full URL to their profile>",
  "display_name":       "<their name or null>",
  "follower_count":     <integer>,
  "following_count":    <integer>,
  "bio_snippet":        "<first 100 chars of their bio or null>",
  "total_score":        <integer>,
  "is_influencer":      <0|1>,
  "engagement_stage":   <0-6>,
  "last_engaged_at":    "<ISO 8601 timestamp or null>",
  "dm_pivot_attempted": <0|1>,
  "dm_channel":         "<whatsapp|ig_dm|null>",
  "coupon_referenced":  <0|1>,
  "coupon_code":        "<code string or null>",
  "urgency_used":       <0|1>,
  "is_converted":       <0|1>,
  "converted_at":       "<ISO 8601 or null>",
  "is_do_not_engage":   <0|1>,
  "source_type":        "<competitor_commenter|competitor_liker|hashtag|manual>",
  "source_handle":      "<@handle or #hashtag where discovered>",
  "notes":              "<any observations — purchase signals, influencer collab potential, etc.>",
  "created_at":         "<ISO 8601>",
  "updated_at":         "<ISO 8601 — update on every change>"
}

outreach-log.ndjson — APPEND only. One JSON object per line. Never rewrite this file.
Write one line immediately after each action (success or failure):
{"lead_id":<int>,"platform":"<plat>","action_type":"<story_view|like|follow|comment|reply|dm|dm_pivot|coupon_sent>","post_url":"<url or null>","content_used":"<exact text sent or null>","persona_id":"<id or null>","proxy_verified":<0|1>,"success":<0|1>,"error_msg":"<null or error text>","username":"<handle>","display_name":"<name or null>","timestamp":"<ISO 8601>"}

━━━ PLAYWRIGHT SETUP ━━━
ALWAYS use headed mode (headless: false). Xvfb is running on DISPLAY=:99.
Use launchPersistentContext with the platform's session dir so login cookies persist.
${clientConfig.proxy?.url ? `Proxy URL: ${clientConfig.proxy.url}` : 'No proxy configured.'}

Standard launch (write to /tmp/lg-XXXX.js and run with node):
\`\`\`javascript
const { chromium } = require('playwright');
(async () => {
  const SESSION_DIR = '<platform session dir from list below>';
  const opts = {
    headless: false,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
  };
  ${clientConfig.proxy?.url ? (() => {
    const raw = clientConfig.proxy.url;
    return `const proxyUrl = ${JSON.stringify(raw.includes('://') ? raw : 'http://' + raw)};
  const u = new URL(proxyUrl);
  opts.proxy = { server: u.protocol + '//' + u.host };
  if (u.username) opts.proxy.username = decodeURIComponent(u.username);
  if (u.password) opts.proxy.password = decodeURIComponent(u.password);`;
  })() : '// No proxy'}
  const context = await chromium.launchPersistentContext(SESSION_DIR, opts);
  const page = context.pages()[0] || await context.newPage();
  // ... your automation ...
  await context.close();
})();
\`\`\`

━━━ SESSION DIRS ━━━
${Object.entries(clientConfig.platforms || {}).filter(([,v]) => v.enabled).map(([k,v]) =>
  `${k}: ${v.sessionDir || path.join(dataDir, 'clients', clientId, 'sessions', k)}`
).join('\n') || 'No platforms enabled — configure platforms in the client settings.'}

━━━ GEO VERIFICATION ━━━
${clientConfig.proxy?.url ? `BEFORE opening any social platform:
1. Navigate to https://whatismyip.com and read the displayed country/city.
2. Verify it matches expected geo: "${clientConfig.proxy.geo || 'any'}".
3. If mismatch: STOP immediately. Log the error. Do not proceed.` : 'No proxy configured — skip geo check.'}

━━━ WORKFLOW ━━━

**PHASE A — SCRAPE NEW TARGETS**
For each enabled source (process in the order listed above):
1. Open the platform session. If not logged in → STOP and log (do not attempt login).
2. Navigate to competitor profile or hashtag page.
3. Competitor sources:
   a. Open their last 5 posts. For each, collect all comment authors → source_type = competitor_commenter
   b. Open their last 3 posts likers list → source_type = competitor_liker
   c. Check if the target follows this competitor → +${cfg.scoring?.follows_competitor || 20} pts
4. Hashtag sources:
   a. Collect the last 20 post authors from the hashtag feed → source_type = hashtag
5. For each discovered username:
   a. Check leads.json — if username+platform already exists: skip
   b. Visit their profile. Read: follower_count, following_count, bio (first 100 chars), recent posts
   c. Score them using the scoring table above
   d. If follower_count ≥ ${cfg.thresholds?.influencer_min_followers || 5000} → is_influencer = 1
   e. Note any purchase intent signals in their bio or recent post captions
   f. If score < ${cfg.thresholds?.min_score_to_engage || 20}: skip (do not add to leads.json)
   g. Add to leads.json with engagement_stage = 0, all timestamps = now
6. Write the full updated leads.json back to disk after each batch of 10 new leads.

**PHASE B — WORK THE PIPELINE**
Load all leads from leads.json. Process in this priority order:
Priority 1: Influencers at stage 0-3 → skip to stage 4 (comment) immediately
Priority 2: Hot leads (score ≥ ${cfg.thresholds?.min_score_for_dm || 60}) at stage < 6 → advance as far as possible
Priority 3: Mid leads (score ${cfg.thresholds?.min_score_for_comment || 40}-${(cfg.thresholds?.min_score_for_dm || 60) - 1}) at stage 2-3 → advance one step
Priority 4: New leads (stage 0) → do steps 1 and 2 (story + like)

For each lead being processed:
- Check last_engaged_at: skip if within ${cfg.pipeline?.cooldown_between_engagements_hours || 48}h
- Check rate limit counters — stop category if limit hit (e.g., max follows reached → skip all follow steps)
- Execute the appropriate ladder step
- Update engagement_stage, last_engaged_at, updated_at in leads.json
- Append to outreach-log.ndjson
- Random delay ${delayMin}-${delayMax}ms between actions, 30-90s between profiles

Stop after processing ${maxLeads} leads total.
Write leads.json back to disk every 5 leads processed.

**PHASE C — COUPON + DM PIVOT**
After Phase B, loop through leads at stage 6 (DM sent) who haven't received a coupon:
${activeCoupons.length ? `- If lead score ≥ ${activeCoupons[0]?.min_lead_score || 70} and platform in [${(activeCoupons[0]?.platforms || []).join(', ')}]:
  Send follow-up DM with coupon using template above. Fill all placeholders.
  Set coupon_referenced = 1, coupon_code = "${activeCoupons[0]?.code}", updated_at = now.
  Append coupon_sent to outreach log.` : '- No active coupons. Skip coupon step.'}

Purchase intent pivot:
- For any lead whose notes or bio_snippet contain purchase intent signals AND WhatsApp is configured:
  Attempt DM pivot: "Would it be easier to chat on WhatsApp? Here's our number: ${cfg.brand?.whatsapp_number || '[not set]'}"
  Set dm_pivot_attempted = 1, dm_channel = "whatsapp", updated_at = now.
  Append dm_pivot to outreach log.

━━━ SAFETY RULES ━━━
- NEVER mention "${clientConfig.name}" or any brand name in a public comment on a competitor's post
- NEVER include a URL/link in a first DM
- NEVER send more than one DM to the same person per session
- If an account shows a restriction warning, unusual CAPTCHA, or "action blocked": STOP for that platform,
  take a screenshot to ${screenshotsDir}/, log the error, move to the next platform
- If prompted to log in or a QR code appears: STOP and log — never attempt automatic login
- Randomise all delays — never use fixed intervals
- If any rate limit is hit: stop that action type for the rest of the session, don't compensate on other actions

━━━ SCREENSHOTS ━━━
Save screenshots (for audit trail) at:
  Before each new platform session: ${screenshotsDir}/before-{platform}-{timestamp}.png
  After completing each source: ${screenshotsDir}/after-{source}-{timestamp}.png
  On any error: ${screenshotsDir}/error-{platform}-{timestamp}.png
Create the directory if it doesn't exist.

━━━ OUTPUT ━━━
After completing all phases, print this structured summary:

=== LEAD GEN SESSION SUMMARY ===
Platform(s): [list]
Duration: [X] minutes

Phase A — Scrape:
  Sources processed: N
  New leads discovered: N
  New leads added to pipeline: N (above score threshold)
  Leads skipped (below threshold): N

Phase B — Pipeline:
  Leads processed: N
  Story views: N
  Likes sent: N
  Follows sent: N
  Comments posted: N
  Replies posted: N
  DMs sent: N
  Leads advanced in stage: N

Phase C — Conversion:
  Coupons sent: N
  DM pivots attempted: N
  WhatsApp numbers shared: N

Pipeline totals (end of session):
  Stage 0 (Discovered): N
  Stage 1 (Story Viewed): N
  Stage 2 (Liked): N
  Stage 3 (Followed): N
  Stage 4 (Commented): N
  Stage 5 (Replied Q): N
  Stage 6 (DM Sent): N
  Converted: N

Errors/skipped: [list any issues]
================================`;
}

module.exports = { buildLeadGenPrompt };
