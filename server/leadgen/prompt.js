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

  // Current pipeline snapshot for context
  const leads    = readJson(path.join(lgDir, 'leads.json'), []);
  const active   = leads.filter(l => !l.is_do_not_engage);
  const pipelineSnap = {
    total:      active.length,
    byStage:    [0,1,2,3,4,5,6].map(s => ({ stage: s, count: active.filter(l => l.engagement_stage === s).length })),
    hot:        active.filter(l => l.total_score >= (cfg.thresholds?.min_score_for_dm || 60)).length,
    converted:  leads.filter(l => l.is_converted).length,
  };

  const enabledSources = sources.filter(s => s.enabled);
  const enabledPersonas = personas.filter(p => p.enabled);

  const leadsJsonPath = path.join(lgDir, 'leads.json');
  const logNdjsonPath = path.join(lgDir, 'outreach-log.ndjson');

  return `You are running a FULLY AUTONOMOUS lead generation session for the brand "${clientConfig.name}".
Do NOT ask for confirmation. Do NOT pause. Make decisions and proceed.
Only stop for: login required, proxy geo mismatch, account restriction warning.

━━━ ENVIRONMENT ━━━
Client ID: ${clientId}
Leads DB:  ${leadsJsonPath}
Action log: ${logNdjsonPath}
Proxy: ${clientConfig.proxy?.url ? 'configured' : 'none'}
Expected geo: ${clientConfig.proxy?.geo || 'any'}

━━━ BRAND CONTEXT ━━━
WhatsApp: ${cfg.brand?.whatsapp_number || 'not set'}
Website: ${cfg.brand?.website_url || 'not set'}
DM CTA: "${cfg.brand?.dm_cta || 'Send us a DM for details'}"
Promo active: ${cfg.brand?.promo_active ? 'YES — urgency language ALLOWED' : 'no'}
Niche keywords: ${(cfg.niche_keywords || []).join(', ')}

━━━ SCORING RULES ━━━
Apply these point values when evaluating each discovered user:
${JSON.stringify(cfg.scoring || {}, null, 2)}

Thresholds:
- Min score to engage: ${cfg.thresholds?.min_score_to_engage || 20}
- Min score for comment: ${cfg.thresholds?.min_score_for_comment || 40}
- Min score for DM: ${cfg.thresholds?.min_score_for_dm || 60}
- Min score to share coupon: ${cfg.thresholds?.min_score_for_coupon || 70}
- Influencer = follower count ≥ ${cfg.thresholds?.influencer_min_followers || 5000}

━━━ PIPELINE RULES ━━━
- Cooldown: ${cfg.pipeline?.cooldown_between_engagements_hours || 48}h between touching the same user
- Follow-back wait before DM: ${cfg.pipeline?.dm_followback_wait_days || 3} days
${clientConfig.platforms?.instagram?.handle ? `- Account age < ${cfg.pipeline?.warmup_days || 14} days → apply ${cfg.pipeline?.warmup_multiplier || 0.5}x rate limit` : ''}

━━━ CURRENT PIPELINE SNAPSHOT ━━━
Total leads: ${pipelineSnap.total}
Stage breakdown: ${pipelineSnap.byStage.map(s => `Stage${s.stage}=${s.count}`).join(', ')}
Hot leads ready for DM: ${pipelineSnap.hot}
Converted: ${pipelineSnap.converted}

━━━ HOT SOURCES TO SCRAPE (${enabledSources.length} enabled) ━━━
${enabledSources.map(s => `- [${s.platform}] ${s.source_type}: ${s.handle_or_tag}  (last scraped: ${s.last_scraped_at || 'never'})`).join('\n') || 'No sources configured — add sources in the Lead Gen tab.'}

━━━ PERSONAS (${enabledPersonas.length} available) ━━━
${enabledPersonas.map(p => `ID: ${p.id}
  Name: ${p.name}  |  Platforms: ${(p.platforms || []).join(', ')}
  Voice: ${p.voice}
  Comment openers: ${(p.comment_openers || []).join(' / ')}
  DM voice: ${p.dm_voice}`).join('\n\n') || 'No personas configured.'}

━━━ COUPON CONFIG ━━━
${coupons.active_coupons?.length ? coupons.active_coupons.filter(c => c.enabled).map(c =>
  `Code: ${c.code}  |  Label: ${c.label}  |  Min score to send: ${c.min_lead_score}`
).join('\n') : 'No active coupons.'}
DM coupon template: "${coupons.dm_coupon_template || ''}"

━━━ THE 6-STEP ENGAGEMENT LADDER ━━━
Execute steps in order. Never skip a step. Each step unlocks the next.

STEP 1 — Story View (stage 1)
  If the target has active stories: view them (passive, zero risk). No interaction.

STEP 2 — Like (stage 2)
  Like their 2 most recent posts. Natural, no comment yet.

STEP 3 — Follow (stage 3)
  Follow their account.

STEP 4 — Comment (stage 4, only if score ≥ min_score_for_comment)
  Leave ONE genuine comment on their most relevant post.
  Use a comment opener from the active persona. NO brand mention. NO CTA. Just value.
  Keep it under 20 words. Sound human, not promotional.

STEP 5 — Reply to question (stage 5)
  If they asked a question on the competitor post: reply with a genuinely useful answer.
  Still no brand mention. Build credibility.

STEP 6 — DM (stage 6, only if score ≥ min_score_for_dm AND they followed back within cooldown)
  Send a warm, curiosity-driven DM in the persona's voice.
  NO pitch. NO links in first DM. Open with something specific from their post/profile.
  If score ≥ min_score_for_coupon AND promo_active: include coupon on second message only.
  DM pivot: if their comments suggest they're ready to buy → mention WhatsApp: "${cfg.brand?.whatsapp_number || ''}"

━━━ DATA SCHEMAS ━━━

leads.json format (read existing, then write back the full array):
{
  "id": <integer, auto-increment>,
  "platform": "<instagram|tiktok|x|whatsapp>",
  "username": "<handle without @>",
  "profile_url": "<url>",
  "display_name": "<name or null>",
  "follower_count": <number>,
  "following_count": <number>,
  "bio_snippet": "<first 100 chars of bio or null>",
  "total_score": <number>,
  "is_influencer": <0|1>,
  "engagement_stage": <0-6>,
  "last_engaged_at": "<ISO 8601 or null>",
  "dm_pivot_attempted": <0|1>,
  "dm_channel": "<whatsapp|ig_dm|null>",
  "coupon_referenced": <0|1>,
  "coupon_code": "<code or null>",
  "urgency_used": <0|1>,
  "is_converted": <0|1>,
  "converted_at": "<ISO 8601 or null>",
  "is_do_not_engage": <0|1>,
  "source_type": "<competitor_commenter|competitor_liker|hashtag|manual>",
  "source_handle": "<@handle or #hashtag>",
  "notes": "<any relevant notes>",
  "created_at": "<ISO 8601>",
  "updated_at": "<ISO 8601>"
}

outreach-log.ndjson format (APPEND one line per action — do NOT rewrite the file):
{"lead_id":<id>,"platform":"<platform>","action_type":"<story_view|like|follow|comment|reply|dm|dm_pivot|coupon_sent>","post_url":"<url or null>","content_used":"<text used or null>","persona_id":"<persona id or null>","proxy_verified":<0|1>,"success":<0|1>,"error_msg":"<null or error>","username":"<handle>","display_name":"<name or null>","timestamp":"<ISO 8601>"}

━━━ PLAYWRIGHT SETUP ━━━
ALWAYS use headed mode (headless: false), DISPLAY=:99.
Use launchPersistentContext with the platform's session_dir from platforms.json.
${clientConfig.proxy?.url ? `Proxy: ${clientConfig.proxy.url}` : 'No proxy configured.'}

Standard launch pattern:
\`\`\`javascript
const { chromium } = require('playwright');
(async () => {
  const opts = {
    headless: false,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'],
  };
  ${clientConfig.proxy?.url ? `const u = new URL(${JSON.stringify(clientConfig.proxy.url)}.includes('://') ? ${JSON.stringify(clientConfig.proxy.url)} : 'http://' + ${JSON.stringify(clientConfig.proxy.url)});
  opts.proxy = { server: u.protocol + '//' + u.host };
  if (u.username) opts.proxy.username = decodeURIComponent(u.username);
  if (u.password) opts.proxy.password = decodeURIComponent(u.password);` : '// No proxy'}
  const context = await chromium.launchPersistentContext(SESSION_DIR, opts);
  const page = context.pages()[0] || await context.newPage();
  // automation here
  await context.close();
})();
\`\`\`

━━━ SESSION DIRS ━━━
${Object.entries(clientConfig.platforms || {}).filter(([,v]) => v.enabled).map(([k,v]) =>
  `${k}: ${v.sessionDir || path.join('/app/data/clients', clientId, 'sessions', k)}`
).join('\n') || 'No platforms configured — check client settings.'}

━━━ WORKFLOW ━━━

**PHASE A — SCRAPE NEW TARGETS**
For each enabled source in hot-sources:
1. Open the competitor profile or hashtag page using the appropriate platform session
2. If competitor: collect usernames from comments on their last 5 posts. Note: commenter = higher intent.
3. If competitor: collect usernames from likers on their last 3 posts.
4. If hashtag: collect post authors from the last 20 posts in the hashtag.
5. For each discovered username: check if they exist in leads.json
   - If yes: skip (already in pipeline)
   - If no: visit their profile, collect follower_count, bio, then score them
6. Score each user:
   - Comment on competitor post: +${cfg.scoring?.comment_on_competitor || 30} pts
   - Like on competitor: +${cfg.scoring?.like_on_competitor || 10} pts
   - Follows competitor: +${cfg.scoring?.follows_competitor || 20} pts
   - Has question in their post: +${cfg.scoring?.has_question_in_post || 25} pts
   - Follower 1k-5k: +${cfg.scoring?.follower_count_1k_5k || 10}, 5k-50k: +${cfg.scoring?.follower_count_5k_50k || 20}, 50k+: +${cfg.scoring?.follower_count_50k_plus || 30}
   - Bio contains niche keyword: +${cfg.scoring?.bio_keyword_match || 15} pts
7. Skip anyone below min_score_to_engage (${cfg.thresholds?.min_score_to_engage || 20})
8. Add qualifying leads to leads.json with engagement_stage = 0

**PHASE B — WORK THE PIPELINE**
From leads.json, process leads in this order:
1. Hot leads (score ≥ ${cfg.thresholds?.min_score_for_dm || 60}) who haven't been DM'd yet → advance to highest possible stage
2. Mid-tier leads (score ${cfg.thresholds?.min_score_for_comment || 40}-${(cfg.thresholds?.min_score_for_dm || 60) - 1}) stuck at stage 2 or 3 → advance one step
3. New leads (stage 0) → execute step 1 (story view) and step 2 (like)
Process max 20 leads per session to avoid rate limit flags.
For each lead: check last_engaged_at — skip if within ${cfg.pipeline?.cooldown_between_engagements_hours || 48}h cooldown.

**PHASE C — COUPON + DM PIVOT**
After completing the ladder steps:
- For any lead at stage 6 who hasn't received a coupon AND score ≥ ${cfg.thresholds?.min_score_for_coupon || 70}:
  ${coupons.active_coupons?.some(c => c.enabled) ? `Send a follow-up DM using coupon: ${coupons.active_coupons.filter(c=>c.enabled)[0]?.code || 'see config'}` : 'No active coupons — skip.'}
- If a lead's bio or comments show purchase intent → attempt DM pivot to WhatsApp

━━━ SAFETY RULES ━━━
- Never mention the brand name in a public comment on a competitor's post
- Never include a link in a first DM
- If an account shows a restriction warning or CAPTCHA: STOP, screenshot to logs/screenshots/, log the error, skip that account
- If prompted to log in / QR code appears: STOP and log — do not attempt login
- Randomise delays: 3-8 seconds between actions, 30-90 seconds between profiles
- Max actions per platform per session: 50 (likes + follows + comments combined)

━━━ OUTPUT ━━━
After the session, print a structured summary:
- New leads discovered: N
- Leads advanced in pipeline: N
- DMs sent: N
- Coupons shared: N
- DM pivots attempted: N
- Errors/skipped: N (with reasons)
- Pipeline totals by stage`;
}

module.exports = { buildLeadGenPrompt };
