const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const backup = require('./backup');
const lgDb           = require('./leadgen/db');
const { buildLeadGenPrompt } = require('./leadgen/prompt');

// Track in-flight automation processes keyed by runId
const runningProcesses = new Map();
// Track active session browser processes keyed by "clientId:platform"
const sessionProcesses = new Map();

// ─── Model pricing (USD per 1M tokens, approximate) ───────────────────────────
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
  'gpt-4o-mini':               { input: 0.15,  output: 0.60  },
  'gpt-4o':                    { input: 2.50,  output: 10.00 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-6'];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
function charsToTokens(chars) { return Math.ceil(chars / 4); }

function getClientRuns(clientId) {
  const f = path.join(CLIENTS_DIR, clientId, 'logs', 'runs.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function getTodayCost(clientId) {
  const today = new Date().toISOString().slice(0, 10);
  return getClientRuns(clientId)
    .filter(r => r.cost_usd > 0 && r.startedAt?.slice(0, 10) === today)
    .reduce((s, r) => s + r.cost_usd, 0);
}

// ─── Budget alerts ────────────────────────────────────────────────────────────
const sentAlerts = new Set(); // "clientId:threshold:YYYY-MM-DD"

async function sendEmail(config, { to, subject, text }) {
  if (!config.smtpHost || !config.smtpUser) throw new Error('SMTP not configured');
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: parseInt(config.smtpPort) || 587,
    secure: parseInt(config.smtpPort) === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
  await transporter.sendMail({
    from: `"AI Social Pilot" <${config.smtpFrom || config.smtpUser}>`,
    to,
    subject,
    text,
  });
}

async function checkAndSendBudgetAlert(config, clientConfig) {
  const budget = parseFloat(clientConfig.daily_budget_usd);
  const alertEmail = clientConfig.budget_alert_email;
  if (!budget || budget <= 0 || !alertEmail) return;
  const today = new Date().toISOString().slice(0, 10);
  const spent = getTodayCost(clientConfig.clientId);
  const pct = spent / budget;
  for (const threshold of [0.8, 1.0]) {
    if (pct >= threshold) {
      const key = `${clientConfig.clientId}:${threshold}:${today}`;
      if (sentAlerts.has(key)) continue;
      sentAlerts.add(key);
      try {
        await sendEmail(config, {
          to: alertEmail,
          subject: `[AI Social Pilot] Budget ${threshold >= 1 ? 'Exceeded' : 'Warning (80%)'} — ${clientConfig.name}`,
          text: [
            `Budget alert for: ${clientConfig.name}`,
            ``,
            `Daily budget:  $${budget.toFixed(4)}`,
            `Spent today:   $${spent.toFixed(4)} (${Math.round(pct * 100)}%)`,
            threshold >= 1
              ? `\nYour daily budget has been EXCEEDED. Further runs are blocked until midnight UTC.`
              : `\n${((budget - spent)).toFixed(4)} remaining before your daily budget is reached.`,
            ``,
            `Tip: To increase the budget or change alert settings, edit the client in your AI Social Pilot admin panel.`,
          ].join('\n'),
        });
        console.log(`[budget] Alert sent to ${alertEmail} (${clientConfig.clientId} at ${Math.round(pct*100)}%)`);
      } catch (e) {
        console.error(`[budget] Email failed:`, e.message);
      }
    }
  }
}

const PLATFORM_URLS = {
  instagram: 'https://www.instagram.com',
  tiktok:    'https://www.tiktok.com',
  x:         'https://www.x.com',
  whatsapp:  'https://web.whatsapp.com',
};

const app = express();
// VNC proxy — forwards /vnc/* to noVNC on port 6080 (live browser view)
const vncProxy = httpProxy.createProxyServer({ target: 'http://localhost:6080', ws: true });
app.use('/vnc', (req, res) => {
  req.url = req.url === '' ? '/' : req.url;
  vncProxy.web(req, res);
});
app.use(express.json());
// Serve admin panel — works whether index.js is at root or in server/ subdir
const ADMIN_DIR = fs.existsSync(path.join(__dirname, '../admin/public'))
  ? path.join(__dirname, '../admin/public')   // Docker: server/index.js → ../admin/public
  : __dirname;                                 // Local dev: flat structure, serve from root
app.use(express.static(ADMIN_DIR));

// ─── Data paths ───
// Docker: /app/data (volume mounted). Local dev: ./data next to index.js
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
const CLIENTS_DIR = path.join(DATA_DIR, 'clients');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Ensure directories exist
[DATA_DIR, CLIENTS_DIR, LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Default config ───
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaults = {
      setupComplete: false,
      anthropicApiKey: '',
      licenseKey: '',
      licenseValid: false,
      licenseLastCheck: null,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ─── License validation ───
const LICENSE_SERVER = process.env.LICENSE_SERVER || 'https://license.socialpilot.ai';
const LICENSE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

async function validateLicense(key) {
  // Dev bypass — remove before production
  if (key === 'SP-DEV-LOCAL-2026') {
    return { valid: true, plan: 'pro', maxClients: 99, expiresAt: null, message: 'Dev mode' };
  }

  try {
    const machineId = getMachineId();
    const res = await fetch(`${LICENSE_SERVER}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey: key,
        machineId,
        product: 'socialpilot-ai',
        version: getVersion(),
      }),
    });
    const data = await res.json();
    return {
      valid: data.valid === true,
      plan: data.plan || 'starter',
      maxClients: data.maxClients || 3,
      expiresAt: data.expiresAt || null,
      message: data.message || '',
    };
  } catch (err) {
    console.error('License check failed:', err.message);
    // Grace period: if we've validated before, allow continued use for 7 days
    const config = loadConfig();
    if (config.licenseValid && config.licenseLastCheck) {
      const daysSinceCheck = (Date.now() - new Date(config.licenseLastCheck).getTime()) / 86400000;
      if (daysSinceCheck < 7) {
        return { valid: true, plan: 'grace', maxClients: 99, message: 'Offline grace period' };
      }
    }
    return { valid: false, message: 'Cannot reach license server' };
  }
}

function getMachineId() {
  try {
    return execSync('cat /etc/machine-id 2>/dev/null || hostname').toString().trim();
  } catch {
    return crypto.randomBytes(16).toString('hex');
  }
}

function getVersion() {
  try {
    const pkgPath = fs.existsSync(path.join(__dirname, '../package.json'))
      ? path.join(__dirname, '../package.json')
      : path.join(__dirname, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

// Periodic license check
setInterval(async () => {
  const config = loadConfig();
  if (config.licenseKey) {
    const result = await validateLicense(config.licenseKey);
    config.licenseValid = result.valid;
    config.licenseLastCheck = new Date().toISOString();
    config.licensePlan = result.plan;
    config.maxClients = result.maxClients;
    saveConfig(config);
  }
}, LICENSE_CHECK_INTERVAL);

// ─── Middleware: license check ───
function requireLicense(req, res, next) {
  const config = loadConfig();
  if (!config.licenseValid) {
    return res.status(403).json({ error: 'Invalid or missing license. Please activate your license key.' });
  }
  next();
}

// ═══════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════

// ─── Status ───
app.get('/api/status', (req, res) => {
  const config = loadConfig();
  const clients = getClients();
  res.json({
    setupComplete: config.setupComplete,
    licenseValid: config.licenseValid,
    licensePlan: config.licensePlan || null,
    maxClients: config.maxClients || 3,
    clientCount: clients.length,
    version: getVersion(),
  });
});

// ─── License ───
app.post('/api/license/activate', async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: 'License key required' });

  const result = await validateLicense(licenseKey);
  const config = loadConfig();
  config.licenseKey = licenseKey;
  config.licenseValid = result.valid;
  config.licenseLastCheck = new Date().toISOString();
  config.licensePlan = result.plan;
  config.maxClients = result.maxClients;
  saveConfig(config);

  res.json(result);
});

// ─── Setup (API keys + model preferences) ───
app.post('/api/setup', async (req, res) => {
  const { anthropicApiKey, openaiApiKey, keepAnthropicKey, aiProvider, anthropicModel, openaiModel,
          smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom } = req.body;
  const config = loadConfig();

  // Allow updating without re-entering existing key (Settings page flow)
  const resolvedAnthropicKey = anthropicApiKey || (keepAnthropicKey ? config.anthropicApiKey : '');
  if (!resolvedAnthropicKey) return res.status(400).json({ error: 'Anthropic API key required (needed for browser automation)' });

  config.anthropicApiKey = resolvedAnthropicKey;
  if (openaiApiKey) config.openaiApiKey = openaiApiKey;   // only overwrite if a new key was provided
  config.aiProvider = aiProvider || config.aiProvider || 'anthropic';
  config.anthropicModel = anthropicModel || config.anthropicModel || 'claude-haiku-4-5-20251001';
  config.openaiModel = openaiModel || config.openaiModel || 'gpt-4o-mini';

  // SMTP (only overwrite if provided)
  if (smtpHost !== undefined) config.smtpHost = smtpHost;
  if (smtpPort !== undefined) config.smtpPort = smtpPort;
  if (smtpUser !== undefined) config.smtpUser = smtpUser;
  if (smtpPass !== undefined) config.smtpPass = smtpPass;
  if (smtpFrom !== undefined) config.smtpFrom = smtpFrom;

  config.setupComplete = true;
  saveConfig(config);

  res.json({ success: true });
});

// ─── Settings (read current config for the Settings page) ───
app.get('/api/settings', requireLicense, (req, res) => {
  const config = loadConfig();
  // Return config, masking keys partially (last 4 chars visible)
  function mask(key) {
    if (!key) return '';
    return key.length > 8 ? key.slice(0, 4) + '••••••••' + key.slice(-4) : '••••••••';
  }
  res.json({
    anthropicApiKeyMasked: mask(config.anthropicApiKey),
    openaiApiKeyMasked:    mask(config.openaiApiKey),
    anthropicModel: config.anthropicModel || 'claude-haiku-4-5-20251001',
    openaiModel:    config.openaiModel    || 'gpt-4o-mini',
    aiProvider:     config.aiProvider     || 'anthropic',
    hasAnthropicKey: !!config.anthropicApiKey,
    hasOpenaiKey:    !!config.openaiApiKey,
    smtpHost:  config.smtpHost  || '',
    smtpPort:  config.smtpPort  || '587',
    smtpUser:  config.smtpUser  || '',
    smtpFrom:  config.smtpFrom  || '',
    hasSmtp:   !!(config.smtpHost && config.smtpUser && config.smtpPass),
  });
});

// ─── Clients CRUD ───
function getClients() {
  if (!fs.existsSync(CLIENTS_DIR)) return [];
  return fs.readdirSync(CLIENTS_DIR)
    .filter(f => fs.existsSync(path.join(CLIENTS_DIR, f, 'config.json')))
    .map(f => {
      const clientConfig = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, f, 'config.json'), 'utf8'));
      const logFile = path.join(CLIENTS_DIR, f, 'logs', 'activity.json');
      let lastActivity = null;
      if (fs.existsSync(logFile)) {
        try {
          const logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
          const dates = Object.keys(logs).sort().reverse();
          if (dates.length > 0) lastActivity = dates[0];
        } catch {}
      }
      return { id: f, ...clientConfig, lastActivity };
    });
}

app.get('/api/clients', requireLicense, (req, res) => {
  res.json(getClients());
});

app.post('/api/clients', requireLicense, (req, res) => {
  const config = loadConfig();
  const clients = getClients();
  if (clients.length >= (config.maxClients || 3)) {
    return res.status(403).json({ error: `Client limit reached (${config.maxClients}). Upgrade your license for more.` });
  }

  const { name, platforms, proxy, geo, brandVoice } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name required' });

  const clientId = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  const clientDir = path.join(CLIENTS_DIR, clientId);

  if (fs.existsSync(clientDir)) {
    return res.status(409).json({ error: 'Client already exists' });
  }

  // Create client directory structure
  fs.mkdirSync(path.join(clientDir, 'browser-sessions'), { recursive: true });
  fs.mkdirSync(path.join(clientDir, 'logs', 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(clientDir, 'config'), { recursive: true });

  // Save client config
  const clientConfig = {
    name,
    clientId,
    createdAt: new Date().toISOString(),
    platforms: platforms || {
      instagram: { handle: '', enabled: false },
      tiktok: { handle: '', enabled: false },
      x: { handle: '', enabled: false },
      whatsapp: { numbers: [], enabled: false },
    },
    proxy: proxy || { url: '', type: 'residential', geo: geo || 'US' },
    brandVoice: brandVoice || {
      personality: '',
      tone: '',
      emojiMax: 2,
      languages: ['English'],
      neverSay: [],
      alwaysDo: [],
    },
    rateLimits: {
      instagram: { delayMin: 10000, delayMax: 20000, maxPerHour: 15, maxPerDay: 50 },
      tiktok: { delayMin: 15000, delayMax: 25000, maxPerHour: 12, maxPerDay: 40 },
      x: { delayMin: 5000, delayMax: 12000, maxPerHour: 20, maxPerDay: 50 },
      whatsapp: { delayMin: 5000, delayMax: 10000, maxPerHour: null, maxPerDay: null },
    },
    status: 'setup', // setup | active | paused
  };

  fs.writeFileSync(path.join(clientDir, 'config.json'), JSON.stringify(clientConfig, null, 2));
  // Also write brand-voice.md for Claude Code
  fs.writeFileSync(path.join(clientDir, 'config', 'brand-voice.md'),
    `# Brand Voice: ${name}\n\n## Personality\n${brandVoice?.personality || 'Warm and helpful'}\n\n## Tone\n${brandVoice?.tone || 'Conversational, not corporate'}\n`
  );

  res.json({ success: true, clientId, client: clientConfig });
});

app.put('/api/clients/:id', requireLicense, (req, res) => {
  const clientDir = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(clientDir)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const existing = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));
  const updated = { ...existing, ...req.body, clientId: req.params.id };
  fs.writeFileSync(path.join(clientDir, 'config.json'), JSON.stringify(updated, null, 2));

  // Update brand-voice.md if brand voice changed
  if (req.body.brandVoice) {
    const bv = req.body.brandVoice;
    fs.writeFileSync(path.join(clientDir, 'config', 'brand-voice.md'),
      `# Brand Voice: ${updated.name}\n\n## Personality\n${bv.personality || ''}\n\n## Tone\n${bv.tone || ''}\n\n## Emoji\nMax per reply: ${bv.emojiMax || 2}\n\n## Languages\n${(bv.languages || []).join(', ')}\n\n## Never Say\n${(bv.neverSay || []).map(s => `- ${s}`).join('\n')}\n\n## Always Do\n${(bv.alwaysDo || []).map(s => `- ${s}`).join('\n')}\n`
    );
  }

  res.json({ success: true, client: updated });
});

app.delete('/api/clients/:id', requireLicense, (req, res) => {
  const clientDir = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(clientDir)) {
    return res.status(404).json({ error: 'Client not found' });
  }
  fs.rmSync(clientDir, { recursive: true });
  res.json({ success: true });
});

// ─── Client logs ───
app.get('/api/clients/:id/logs', requireLicense, (req, res) => {
  const logFile = path.join(CLIENTS_DIR, req.params.id, 'logs', 'activity.json');
  if (!fs.existsSync(logFile)) return res.json({});
  try {
    res.json(JSON.parse(fs.readFileSync(logFile, 'utf8')));
  } catch {
    res.json({});
  }
});

// ─── Build Claude prompt per command ───
function buildPrompt(command, clientConfig) {
  const platforms = Object.entries(clientConfig.platforms || {})
    .filter(([, v]) => v.enabled).map(([k]) => k);
  const ctx = `You are managing social media for the brand "${clientConfig.name}".
Enabled platforms: ${platforms.join(', ') || 'none configured'}.
Always read config/brand-voice.md before drafting any reply.
Proxy geo: ${clientConfig.proxy?.geo || 'not set'}.

`;
  const commands = {
    'check-all': ctx + `Check ALL enabled platforms for new activity. Order: Instagram → TikTok → X → WhatsApp.
IMPORTANT: You are running autonomously — do not ask for approval, post replies directly.
For each platform:
1. Open it and check for new comments, mentions, and DMs since last session
2. Draft and POST replies following the brand voice — never send identical replies
3. Check escalation-rules.md — flag only genuine escalations (complaints, legal threats)
4. Log every action
Finish with a summary: how many items found, replied, escalated, skipped.`,

    'reply-instagram': ctx + `Check Instagram for new activity.
IMPORTANT: You are running autonomously — draft replies and post them directly, do not wait for approval.
1. Open https://instagram.com — verify you are logged in as ${clientConfig.platforms?.instagram?.handle || 'the brand account'}
2. Check all recent posts for new comments (last 24h)
3. Check DM inbox for unread messages
4. For each comment/DM: draft a reply in the brand voice per reply-templates.md, then post it immediately
5. Log all actions. Output a summary of what was replied to.`,

    'reply-tiktok': ctx + `Check TikTok for new activity.
IMPORTANT: You are running autonomously — draft replies and post them directly, do not wait for approval.
1. Open https://tiktok.com — verify login as ${clientConfig.platforms?.tiktok?.handle || 'the brand account'}
2. Check recent videos for new comments
3. For each unanswered comment: draft a reply (under 150 characters, punchy and natural), then post it immediately
4. Log all actions. Output a summary of what was replied to.`,

    'reply-x': ctx + `Check X (Twitter) for new activity.
IMPORTANT: You are running autonomously — draft replies and post them directly, do not wait for approval.
1. Open https://x.com — verify login as ${clientConfig.platforms?.x?.handle || 'the brand account'}
2. Check mentions and DMs
3. For each new mention/DM: draft a reply in brand voice (concise, no hashtags), then post it immediately
4. Log all actions. Output a summary of what was replied to.`,

    'check-whatsapp': ctx + `Check WhatsApp inbox.
IMPORTANT: You are running autonomously — draft replies and send them directly, do not wait for approval.
1. Open https://web.whatsapp.com
2. Identify all unread conversations
3. Categorise each: complaint / booking / product_question / support / general
4. Process in order: complaints → bookings → product questions → general
5. Flag voice notes and images — mark for manual review, skip them
6. For each text message: draft and send a reply in brand voice immediately
7. Log all actions. Output a summary.`,

    'outreach': ctx + `Run competitor audience outreach.
1. Read competitors.json and outreach-rules.json
2. For each enabled competitor, open their profile and collect recent post commenters/likers
3. Score each target per the scoring table in outreach-rules.json
4. Skip anyone below min_score_to_engage
5. Execute the engagement ladder in order (story view → likes → follow → comment → DM on followback)
6. Stay within daily limits in rate-limits.json outreach section
7. Log all actions to logs/outreach-log.json`,

    'leadgen': buildLeadGenPrompt(clientConfig, DATA_DIR),

    'leadgen-report': (() => {
      const lgDir  = path.join(CLIENTS_DIR, clientConfig.clientId, 'leadgen');
      const leads  = (() => { try { return JSON.parse(fs.readFileSync(path.join(lgDir, 'leads.json'), 'utf8')); } catch { return []; } })();
      const active = leads.filter(l => !l.is_do_not_engage);
      const STAGE_LABELS = ['Discovered','Story Viewed','Liked','Followed','Commented','Replied Q','DM Sent'];
      const byStage = STAGE_LABELS.map((label, i) => `  Stage ${i} (${label}): ${active.filter(l => l.engagement_stage === i).length}`).join('\n');
      const hotLeads = active.filter(l => l.total_score >= 60 && !l.is_converted)
        .sort((a,b) => b.total_score - a.total_score)
        .slice(0, 10)
        .map(l => `  @${l.username} (${l.platform}) score=${l.total_score} stage=${l.engagement_stage} followers=${l.follower_count}`)
        .join('\n');
      return `Generate a pipeline health report for "${clientConfig.name}" lead gen system.
Do NOT open any browser. Read only from the data below.

PIPELINE SNAPSHOT:
Total leads: ${active.length}
Converted: ${leads.filter(l=>l.is_converted).length}
DND / removed: ${leads.filter(l=>l.is_do_not_engage).length}
DM Pivots attempted: ${leads.filter(l=>l.dm_pivot_attempted).length}
Coupons sent: ${leads.filter(l=>l.coupon_referenced).length}
Influencers: ${active.filter(l=>l.is_influencer).length}

BY STAGE:
${byStage}

TOP HOT LEADS (score ≥ 60, not yet converted):
${hotLeads || '  None yet.'}

RECENT ACTIONS (last 10 log entries):
${(() => { try {
  return fs.readFileSync(path.join(lgDir, 'outreach-log.ndjson'), 'utf8')
    .split('\n').filter(Boolean).slice(-10).reverse()
    .map(l => { try { const r = JSON.parse(l); return `  ${r.timestamp?.slice(0,16)} @${r.username} ${r.action_type} (${r.platform}) ${r.success ? '✓' : '✗'}`; } catch { return ''; } })
    .filter(Boolean).join('\n');
} catch { return '  No actions logged yet.'; } })()}

YOUR TASK:
1. Print a clean, readable pipeline summary with the above data
2. Highlight leads that are ready for the next stage (e.g., followers who need a DM, DMs that could get a coupon)
3. Calculate conversion rate: ${leads.filter(l=>l.is_converted).length} / ${active.length} = ${active.length ? ((leads.filter(l=>l.is_converted).length / active.length) * 100).toFixed(1) : 0}%
4. Flag any leads stuck in stage 3 (followed, waiting for follow-back) for more than 3 days
5. Suggest 2-3 specific next actions to improve conversion
6. Estimate how many DMs are ready to send based on pipeline data`;
    })(),

    'ambassador': ctx + `Run ambassador network session.
1. Read ambassadors.json, ambassador-content.json, ambassador-rules.json
2. Find briefs with status = "approved" in ambassador-content.json
3. For each target account in the brief, adapt the caption in that ambassador's voice and niche angle
4. Show ALL adapted captions to the user — do not post without approval
5. Once approved, post with natural staggered timing
6. Run cross-engagement after posts go live`,
  };
  const basePrompt = commands[command] || (ctx + command);
  return basePrompt + buildKnowledgeContext(clientConfig.clientId);
}

// Append knowledge base context to every prompt so Claude has full brand intelligence
function buildKnowledgeContext(clientId) {
  if (!clientId) return '';
  const kDir = path.join(CLIENTS_DIR, clientId, 'knowledge');
  const read = file => { try { return JSON.parse(fs.readFileSync(path.join(kDir, file), 'utf8')); } catch { return []; } };

  const products    = read('products.json');
  const competitors = read('competitors.json');
  const keywords    = read('keywords.json');
  const sources     = read('hot-sources.json').filter(s => s.enabled !== false);

  if (!products.length && !competitors.length && !keywords.length && !sources.length) return '';

  const lines = ['\n\n─── BRAND INTELLIGENCE (read this before acting) ───'];

  if (products.length) {
    lines.push('\nPRODUCTS & OFFERS:');
    products.forEach(p => {
      lines.push(`• ${p.name}${p.price ? ` (${p.price})` : ''}${p.url ? ` — ${p.url}` : ''}`);
      if (p.description) lines.push(`  ${p.description}`);
      if (p.pain_points?.length) lines.push(`  Pain points: ${p.pain_points.join('; ')}`);
      if (p.usps?.length) lines.push(`  Benefits: ${p.usps.join('; ')}`);
    });
  }

  if (competitors.length) {
    lines.push('\nCOMPETITORS (never mention these brands in public):');
    competitors.filter(c => c.enabled !== false).forEach(c => {
      const handles = [c.instagram, c.tiktok, c.x].filter(Boolean).join(', ');
      lines.push(`• ${c.name}${c.website ? ` (${c.website.replace(/^https?:\/\//,'')})` : ''}${handles ? ` — socials: ${handles}` : ''}`);
      if (c.weaknesses?.length) lines.push(`  Their weaknesses: ${c.weaknesses.join('; ')}`);
    });
  }

  if (keywords.length) {
    const buying = keywords.filter(k => k.intent === 'transactional' || k.intent === 'commercial').map(k => k.keyword);
    const pains  = keywords.filter(k => k.intent === 'pain-point').map(k => k.keyword);
    if (buying.length) lines.push(`\nBUYING SIGNAL KEYWORDS (engage immediately when you see these): ${buying.join(', ')}`);
    if (pains.length)  lines.push(`PAIN-POINT SIGNALS (offer help/solution when spotted): ${pains.join(', ')}`);
  }

  if (sources.length) {
    lines.push('\nHOT SOURCES TO MINE (prioritise outreach from these):');
    sources.slice(0, 15).forEach(s => lines.push(`• ${s.platform} ${s.type}: ${s.handle_or_url}${s.why ? ` — ${s.why}` : ''}`));
  }

  lines.push('─────────────────────────────────────────────────────');
  return lines.join('\n');
}

// ─── Shared run spawn logic ───
// onData(line) receives output lines; onClose(runId, code, signal, startedAt) is called on exit.
// Returns { runId, proc } or throws if preflight fails.
function spawnRun(clientId, command, onData, onClose) {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const config = loadConfig();
  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));

  const runId = crypto.randomBytes(4).toString('hex');
  const startedAt = new Date().toISOString();

  const prompt = buildPrompt(command, clientConfig);
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    ANTHROPIC_MODEL: config.anthropicModel || 'claude-haiku-4-5-20251001',
    SOCIALPILOT_PROXY: clientConfig.proxy?.url || '',
    EXPECTED_GEO: clientConfig.proxy?.geo || '',
    CLIENT_ID: clientConfig.clientId,
    HOME: process.env.HOME || '/root',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  const tmpPromptFile = `/tmp/claude-prompt-${runId}.txt`;
  fs.writeFileSync(tmpPromptFile, prompt, { mode: 0o644 });

  const se = v => `'${String(v || '').replace(/'/g, "'\\''")}'`;
  const tmpScript = `/tmp/claude-run-${runId}.sh`;
  fs.writeFileSync(tmpScript, [
    '#!/bin/bash',
    `export PATH=${se(process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')}`,
    `export NODE_PATH=${se(process.env.NODE_PATH || '')}`,
    `export PLAYWRIGHT_BROWSERS_PATH=${se(process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright')}`,
    `export ANTHROPIC_API_KEY=${se(env.ANTHROPIC_API_KEY)}`,
    `export ANTHROPIC_MODEL=${se(env.ANTHROPIC_MODEL)}`,
    `export HOME=/home/claude_runner`,
    `export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
    `export DISPLAY=${se(env.DISPLAY || ':99')}`,
    `export SOCIALPILOT_PROXY=${se(env.SOCIALPILOT_PROXY || '')}`,
    `export EXPECTED_GEO=${se(env.EXPECTED_GEO || '')}`,
    `export CLIENT_ID=${se(env.CLIENT_ID || '')}`,
    `rm -rf /home/claude_runner/.claude/projects/ 2>/dev/null || true`,
    `cd ${se(clientDir)}`,
    `cat ${se(tmpPromptFile)} | claude --print --dangerously-skip-permissions`,
  ].join('\n') + '\n', { mode: 0o755 });

  const proc = spawn('/bin/su', ['-s', '/bin/bash', 'claude_runner', '-c', tmpScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runningProcesses.set(runId, { proc, clientId, command, startedAt });

  const model = env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const inputTokens = charsToTokens(prompt.length);
  let outputChars = 0;

  proc.stdout.on('data', chunk => {
    outputChars += chunk.length;
    onData('output', chunk.toString());
  });
  proc.stderr.on('data', chunk => {
    const txt = chunk.toString();
    console.log(`[run ${runId}] stderr: ${txt.substring(0, 200)}`);
    onData('progress', txt);
  });
  proc.on('error', err => onData('error', `Process error: ${err.message}`));

  proc.on('close', (code, signal) => {
    try { fs.unlinkSync(tmpPromptFile); } catch {}
    try { fs.unlinkSync(tmpScript); } catch {}

    runningProcesses.delete(runId);
    const completedAt = new Date().toISOString();
    const status = code === 0 ? 'completed' : code === null ? 'stopped' : 'failed';

    console.log(`[run ${runId}] close: code=${code} signal=${signal}`);

    const outputTokens = charsToTokens(outputChars);
    const cost_usd = estimateCost(model, inputTokens, outputTokens);

    const logFile = path.join(clientDir, 'logs', 'runs.json');
    let runs = [];
    try { runs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {}
    runs.push({ runId, command, startedAt, completedAt, status, exitCode: code, signal,
      cost_usd, input_tokens_est: inputTokens, output_tokens_est: outputTokens, model, provider: 'anthropic' });
    fs.writeFileSync(logFile, JSON.stringify(runs.slice(-100), null, 2));

    // Fire budget alert async (don't block close handler)
    checkAndSendBudgetAlert(config, clientConfig).catch(() => {});

    if (onClose) onClose(runId, code, signal, startedAt, status);
  });

  return { runId, proc, startedAt, clientConfig };
}

// ─── OpenAI direct API path (text-only commands, no browser) ───
// Commands listed here bypass Claude CLI entirely when aiProvider === 'openai'
const TEXT_ONLY_COMMANDS = new Set(['leadgen-report']);

async function runOpenAI(clientId, command, onData, onClose) {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const config = loadConfig();
  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));

  if (!config.openaiApiKey) throw new Error('OpenAI API key not configured');

  const runId = crypto.randomBytes(4).toString('hex');
  const startedAt = new Date().toISOString();
  const model = config.openaiModel || 'gpt-4o-mini';
  const prompt = buildPrompt(command, clientConfig);

  const controller = new AbortController();
  runningProcesses.set(runId, { clientId, command, startedAt, abort: controller });

  let status = 'completed';
  let usageTokens = null;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errText}`);
    }

    // Stream SSE chunks from OpenAI; capture usage from final chunk
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete trailing line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const parsed = JSON.parse(payload);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) onData('output', content);
          // Capture real token usage from the final usage chunk
          if (parsed.usage) {
            usageTokens = { input: parsed.usage.prompt_tokens || 0, output: parsed.usage.completion_tokens || 0 };
          }
        } catch {}
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      status = 'stopped';
      onData('output', '\n[Stopped by user]\n');
    } else {
      status = 'failed';
      onData('error', `OpenAI error: ${err.message}\n`);
    }
  }

  runningProcesses.delete(runId);
  const completedAt = new Date().toISOString();

  const inputTokens  = usageTokens?.input  ?? charsToTokens(prompt.length);
  const outputTokens = usageTokens?.output ?? 0;
  const cost_usd = estimateCost(model, inputTokens, outputTokens);

  const logFile = path.join(clientDir, 'logs', 'runs.json');
  let runs = [];
  try { runs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {}
  runs.push({ runId, command, startedAt, completedAt, status, provider: 'openai', model,
    cost_usd, input_tokens: inputTokens, output_tokens: outputTokens });
  fs.writeFileSync(logFile, JSON.stringify(runs.slice(-100), null, 2));

  checkAndSendBudgetAlert(config, clientConfig).catch(() => {});

  if (onClose) onClose(runId, status === 'completed' ? 0 : 1, null, startedAt, status);
  return { runId, startedAt, clientConfig };
}

// ─── Run automation (SSE streaming) ───
app.post('/api/clients/:id/run', requireLicense, (req, res) => {
  const { command } = req.body;
  const clientDir = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(clientDir)) return res.status(404).json({ error: 'Client not found' });

  const config = loadConfig();
  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));

  if (clientConfig.status === 'paused') {
    return res.status(400).json({ error: 'Client is paused. Set status to Active first.' });
  }
  const willUseOpenAI = config.aiProvider === 'openai' && TEXT_ONLY_COMMANDS.has(command) && config.openaiApiKey;
  if (!willUseOpenAI && !config.anthropicApiKey) {
    return res.status(400).json({ error: 'Anthropic API key not configured. Complete setup first.' });
  }

  // Budget check — block if daily budget exceeded
  const budget = parseFloat(clientConfig.daily_budget_usd);
  if (budget > 0) {
    const spent = getTodayCost(clientConfig.clientId);
    if (spent >= budget) {
      return res.status(429).json({
        error: `Daily budget of $${budget.toFixed(2)} exceeded ($${spent.toFixed(4)} spent today). Budget resets at midnight UTC.`,
      });
    }
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  };

  const t0 = Date.now();

  // Route to OpenAI directly for text-only commands when aiProvider === 'openai'
  const useOpenAI = config.aiProvider === 'openai' && TEXT_ONLY_COMMANDS.has(command) && config.openaiApiKey;

  if (useOpenAI) {
    send('output', { text: `> provider: openai (${config.openaiModel || 'gpt-4o-mini'})\n` });
    let runId, startedAt;
    runOpenAI(
      req.params.id,
      command,
      (type, text) => send(type, { text }),
      (rid, code, signal, sat, status) => {
        send('done', { code, runId: rid, status });
        res.end();
      }
    ).then(result => {
      runId = result.runId;
      startedAt = result.startedAt;
      send('start', { runId, command, clientName: clientConfig.name, startedAt });
    }).catch(err => {
      send('error', { text: `Failed to start: ${err.message}` });
      send('done', { code: 1, status: 'failed' });
      res.end();
    });
    return;
  }

  // Pre-flight: verify claude CLI is available
  const claudePath = (() => { try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return null; } })();
  if (!claudePath) {
    send('output', { text: '✗ claude CLI not found in PATH. Check Docker build logs.\n' });
    send('done', { code: 1, status: 'failed' });
    res.end();
    return;
  }
  const claudeVersion = (() => { try { return execSync('claude --version 2>&1', { encoding: 'utf8', timeout: 10000 }).trim(); } catch (e) { return `error: ${e.message}`; } })();
  send('output', { text: `> claude: ${claudePath} (${claudeVersion})\n` });

  let runResult;
  try {
    runResult = spawnRun(
      req.params.id,
      command,
      (type, text) => send(type, { text }),
      (runId, code, signal, startedAt, status) => {
        if (signal) send('output', { text: `\n[Process killed by signal: ${signal}]\n` });
        send('done', { code, runId, status });
        res.end();
      }
    );
  } catch (err) {
    send('error', { text: `Failed to start: ${err.message}` });
    send('done', { code: 1, status: 'failed' });
    res.end();
    return;
  }

  const { runId, startedAt } = runResult;
  send('start', { runId, command, clientName: clientConfig.name, startedAt });

  // Kill process if SSE connection drops — but only after 10s grace period to avoid
  // killing on Railway proxy reconnects. Railway often drops/re-establishes SSE.
  req.on('close', () => {
    const elapsed = Date.now() - t0;
    console.log(`[run ${runId}] req.close at ${elapsed}ms`);
    const entry = runningProcesses.get(runId);
    if (entry) {
      if (elapsed < 10000) {
        // Too early — likely a Railway proxy reconnect, not a genuine user disconnect
        send('output', { text: `\n[DEBUG: req.close at ${elapsed}ms — ignoring (grace period)]\n` });
        console.log(`[run ${runId}] req.close IGNORED (grace period, ${elapsed}ms < 10s)`);
      } else {
        if (entry.proc) entry.proc.kill('SIGTERM');
        else if (entry.abort) entry.abort.abort();
        runningProcesses.delete(runId);
      }
    }
  });
});

// ─── Scheduled run engine ───
// Maps platform names to automation command names
const SCHEDULE_COMMAND_MAP = {
  instagram: 'reply-instagram',
  tiktok:    'reply-tiktok',
  x:         'reply-x',
  whatsapp:  'check-whatsapp',
  leadgen:   'leadgen',
};

// Tracks already-triggered scheduled runs: "clientId:command:YYYY-MM-DD:HH:MM"
const scheduledRunsTriggered = new Set();
let _scheduleLastClearDate = '';

setInterval(() => {
  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const currentHHMM = now.toISOString().slice(11, 16); // HH:MM

  // Clear triggered set daily at midnight UTC
  if (_scheduleLastClearDate && _scheduleLastClearDate !== todayUTC) {
    scheduledRunsTriggered.clear();
    console.log('[scheduler] Daily reset — cleared triggered run set');
  }
  _scheduleLastClearDate = todayUTC;

  const config = loadConfig();
  if (!config.anthropicApiKey && !config.openaiApiKey) return; // No API key configured, skip

  const clients = getClients();
  for (const client of clients) {
    if (client.status === 'paused') continue;
    if (!client.schedule || typeof client.schedule !== 'object') continue;

    for (const [platform, times] of Object.entries(client.schedule)) {
      if (!Array.isArray(times) || times.length === 0) continue;
      const command = SCHEDULE_COMMAND_MAP[platform];
      if (!command) continue;

      // Lead gen: honour days-of-week filter (client.leadgenSchedule.days, 0=Sun…6=Sat)
      if (platform === 'leadgen') {
        const allowedDays = client.leadgenSchedule?.days;
        if (Array.isArray(allowedDays) && allowedDays.length > 0) {
          const todayDow = now.getUTCDay();
          if (!allowedDays.includes(todayDow)) continue;
        }
      }

      for (const hhmm of times) {
        if (hhmm !== currentHHMM) continue;

        const triggerKey = `${client.clientId}:${command}:${todayUTC}:${hhmm}`;
        if (scheduledRunsTriggered.has(triggerKey)) continue;

        // Skip if a run for this client is already in progress
        const alreadyRunning = [...runningProcesses.values()].some(e => e.clientId === client.clientId);
        if (alreadyRunning) {
          console.log(`[scheduler] Skipping ${triggerKey} — run already in progress`);
          continue;
        }

        scheduledRunsTriggered.add(triggerKey);
        console.log(`[scheduler] Triggering scheduled run: ${triggerKey}`);

        // Ensure logs dir exists
        const clientLogsDir = path.join(CLIENTS_DIR, client.clientId, 'logs');
        if (!fs.existsSync(clientLogsDir)) fs.mkdirSync(clientLogsDir, { recursive: true });
        const schedLogFile = path.join(clientLogsDir, 'scheduled.log');

        const logLine = text => {
          try { fs.appendFileSync(schedLogFile, text); } catch {}
        };

        logLine(`\n[${new Date().toISOString()}] Scheduled run started: ${command} (triggered at ${hhmm} UTC)\n`);

        const schedConfig = loadConfig();
        const useOpenAI = schedConfig.aiProvider === 'openai' && TEXT_ONLY_COMMANDS.has(command) && schedConfig.openaiApiKey;

        if (useOpenAI) {
          runOpenAI(
            client.clientId,
            command,
            (type, text) => { if (type === 'output' || type === 'error') logLine(text); },
            (runId, code, signal, startedAt, status) => {
              logLine(`\n[${new Date().toISOString()}] Scheduled run finished: runId=${runId} status=${status} provider=openai\n`);
              console.log(`[scheduler] Run finished: ${triggerKey} runId=${runId} status=${status}`);
            }
          ).catch(err => {
            logLine(`\n[${new Date().toISOString()}] Scheduled run FAILED to start: ${err.message}\n`);
            console.error(`[scheduler] Failed to start ${triggerKey}:`, err.message);
          });
        } else {
          try {
            spawnRun(
              client.clientId,
              command,
              (type, text) => {
                if (type === 'output' || type === 'error') logLine(text);
              },
              (runId, code, signal, startedAt, status) => {
                logLine(`\n[${new Date().toISOString()}] Scheduled run finished: runId=${runId} status=${status} code=${code}\n`);
                console.log(`[scheduler] Run finished: ${triggerKey} runId=${runId} status=${status}`);
              }
            );
          } catch (err) {
            logLine(`\n[${new Date().toISOString()}] Scheduled run FAILED to start: ${err.message}\n`);
            console.error(`[scheduler] Failed to start ${triggerKey}:`, err.message);
          }
        }
      }
    }
  }
}, 60000); // Check every 60 seconds

// ─── Nightly backup at 02:00 UTC ─────────────────────────────────────────────
setInterval(() => {
  const hhmm = new Date().toISOString().slice(11, 16);
  if (hhmm === '02:00') {
    backup.runBackup(DATA_DIR).catch(err =>
      console.error('[backup] Nightly backup failed:', err.message)
    );
  }
}, 60000);

// ─── Next scheduled run times per platform ───
app.get('/api/clients/:id/next-runs', requireLicense, (req, res) => {
  const clientDir = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(clientDir)) return res.status(404).json({ error: 'Client not found' });

  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));
  const schedule = clientConfig.schedule || {};
  const now = new Date();
  const result = {};

  for (const [platform, times] of Object.entries(schedule)) {
    if (!Array.isArray(times) || times.length === 0) continue;

    // Find the next upcoming time today or tomorrow
    let nextTime = null;
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    // Parse all times as minutes-since-midnight
    const parsedTimes = times
      .map(t => {
        const parts = t.split(':');
        if (parts.length !== 2) return null;
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        if (isNaN(h) || isNaN(m)) return null;
        return { hhmm: t, minutes: h * 60 + m };
      })
      .filter(Boolean)
      .sort((a, b) => a.minutes - b.minutes);

    // Find first time that hasn't passed today
    for (const t of parsedTimes) {
      if (t.minutes > currentMinutes) {
        nextTime = t.hhmm;
        break;
      }
    }
    // If all times have passed, wrap to first time tomorrow
    if (!nextTime && parsedTimes.length > 0) {
      nextTime = parsedTimes[0].hhmm + ' (+1d)';
    }

    if (nextTime) result[platform] = nextTime;
  }

  res.json(result);
});

// ─── Stop a running automation ───
app.post('/api/clients/:id/run/stop', requireLicense, (req, res) => {
  const { runId } = req.body;
  const entry = runningProcesses.get(runId);
  if (!entry || entry.clientId !== req.params.id) {
    return res.status(404).json({ error: 'No running process found' });
  }
  if (entry.proc) entry.proc.kill('SIGTERM');
  else if (entry.abort) entry.abort.abort();
  runningProcesses.delete(runId);
  res.json({ success: true });
});

// ─── Run history for a client ───
app.get('/api/clients/:id/runs', requireLicense, (req, res) => {
  const logFile = path.join(CLIENTS_DIR, req.params.id, 'logs', 'runs.json');
  if (!fs.existsSync(logFile)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(logFile, 'utf8')).reverse().slice(0, 20)); }
  catch { res.json([]); }
});

// ─── Cost analytics for a client ───
app.get('/api/clients/:id/costs', requireLicense, (req, res) => {
  const clientDir = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(clientDir)) return res.status(404).json({ error: 'Client not found' });
  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));

  const runs = getClientRuns(req.params.id);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekAgo  = new Date(now - 7  * 86400000).toISOString().slice(0, 10);
  const monthAgo = new Date(now - 30 * 86400000).toISOString().slice(0, 10);

  const withCost = runs.filter(r => r.cost_usd > 0);

  function sumPeriod(from) {
    return withCost.filter(r => r.startedAt?.slice(0, 10) >= from).reduce((s, r) => s + r.cost_usd, 0);
  }

  const todayCost  = sumPeriod(today);
  const weekCost   = sumPeriod(weekAgo);
  const monthCost  = sumPeriod(monthAgo);
  const budget     = parseFloat(clientConfig.daily_budget_usd) || 0;

  // By-command breakdown (last 30 days)
  const cmdMap = {};
  withCost.filter(r => r.startedAt?.slice(0, 10) >= monthAgo).forEach(r => {
    if (!cmdMap[r.command]) cmdMap[r.command] = { command: r.command, runs: 0, cost_usd: 0 };
    cmdMap[r.command].runs++;
    cmdMap[r.command].cost_usd += r.cost_usd;
  });
  const by_command = Object.values(cmdMap).sort((a, b) => b.cost_usd - a.cost_usd);

  // Last 14 days cost history
  const by_day = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    by_day.push({ date: d, cost_usd: withCost.filter(r => r.startedAt?.slice(0, 10) === d).reduce((s, r) => s + r.cost_usd, 0) });
  }

  // Optimization tip
  const model = runs[runs.length - 1]?.model || '';
  let tip = null;
  if (model.includes('opus')) tip = 'Switch to claude-sonnet for ~80% cost savings with similar quality.';
  else if (model.includes('sonnet')) tip = 'Switch to claude-haiku for ~75% cost savings on routine tasks.';
  else if (model === 'gpt-4o') tip = 'Switch to gpt-4o-mini for ~94% cost savings on text-only tasks.';
  else if (monthCost === 0) tip = 'No cost data yet — run some automations to see insights.';

  // Monthly forecast (based on daily average over last 7 days)
  const forecast_monthly = weekCost > 0 ? (weekCost / 7) * 30 : 0;

  res.json({ todayCost, weekCost, monthCost, budget, budgetPct: budget > 0 ? todayCost / budget : 0,
    by_command, by_day, forecast_monthly, tip, model });
});

// ─── Cost overview across all clients ───
app.get('/api/costs/overview', requireLicense, (req, res) => {
  const clients = getClients();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  let todayTotal = 0, monthTotal = 0;
  const clientSummaries = clients.map(c => {
    const runs = getClientRuns(c.clientId).filter(r => r.cost_usd > 0);
    const tCost = runs.filter(r => r.startedAt?.slice(0, 10) === today).reduce((s, r) => s + r.cost_usd, 0);
    const mCost = runs.filter(r => r.startedAt?.slice(0, 10) >= monthAgo).reduce((s, r) => s + r.cost_usd, 0);
    todayTotal  += tCost;
    monthTotal  += mCost;
    const budget = parseFloat(c.daily_budget_usd) || 0;
    return { id: c.clientId, name: c.name, todayCost: tCost, monthCost: mCost,
      budget, budgetPct: budget > 0 ? tCost / budget : null };
  });

  res.json({ todayTotal, monthTotal, clients: clientSummaries });
});

// ─── Session setup: open a headed browser for manual login ───
app.post('/api/clients/:id/session/start', requireLicense, (req, res) => {
  const { platform } = req.body;
  const clientDir = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(clientDir)) return res.status(404).json({ error: 'Client not found' });

  const url = PLATFORM_URLS[platform];
  if (!url) return res.status(400).json({ error: `Unknown platform: ${platform}` });

  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));
  const sessionDir = path.join(clientDir, 'browser-sessions', platform);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Kill any existing session for this platform
  const key = `${req.params.id}:${platform}`;
  if (sessionProcesses.has(key)) {
    try { sessionProcesses.get(key).kill('SIGTERM'); } catch {}
    sessionProcesses.delete(key);
  }

  const scriptPath = path.join(__dirname, '../scripts/open-session.js');
  const proxyUrl = clientConfig.proxy?.url || '';
  const args = [scriptPath, url, sessionDir];
  if (proxyUrl) args.push(proxyUrl);

  let proc;
  try {
    proc = spawn('node', args, {
      env: { ...process.env, DISPLAY: ':99' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to launch browser: ${err.message}` });
  }

  sessionProcesses.set(key, proc);
  proc.stdout.on('data', chunk => console.log(`[session:${platform}] ${chunk.toString().trim()}`));
  proc.stderr.on('data', chunk => console.error(`[session:${platform}] ${chunk.toString().trim()}`));
  proc.on('close', () => sessionProcesses.delete(key));

  res.json({ success: true, platform, message: `Browser opened at ${url}` });
});

// ─── Session setup: close the browser and mark session as saved ───
app.post('/api/clients/:id/session/stop', requireLicense, (req, res) => {
  const { platform } = req.body;
  const key = `${req.params.id}:${platform}`;
  if (sessionProcesses.has(key)) {
    try { sessionProcesses.get(key).kill('SIGTERM'); } catch {}
    sessionProcesses.delete(key);
  }
  res.json({ success: true });
});

// ─── Session status: which platforms have saved sessions ───
app.get('/api/clients/:id/sessions', requireLicense, (req, res) => {
  const sessionsDir = path.join(CLIENTS_DIR, req.params.id, 'browser-sessions');
  const status = {};
  for (const platform of Object.keys(PLATFORM_URLS)) {
    const dir = path.join(sessionsDir, platform);
    const hasFiles = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    const isActive = sessionProcesses.has(`${req.params.id}:${platform}`);
    status[platform] = { hasSession: hasFiles, isActive };
  }
  res.json(status);
});

// ─── Debug: test claude CLI in the actual container environment ───
app.get('/api/debug-claude', (req, res) => {
  const config = loadConfig();
  const results = {};

  // 1. Check binary
  try { results.which = execSync('which claude', { encoding: 'utf8' }).trim(); } catch (e) { results.which = `ERR: ${e.message}`; }
  try { results.version = execSync('claude --version 2>&1', { encoding: 'utf8', timeout: 10000 }).trim(); } catch (e) { results.version = `ERR: ${e.message}`; }

  // 2. Check settings files
  try { results.settingsRoot = JSON.parse(fs.readFileSync('/root/.claude/settings.json', 'utf8')); } catch (e) { results.settingsRoot = `ERR: ${e.message}`; }
  try { results.settingsRunner = JSON.parse(fs.readFileSync('/home/claude_runner/.claude/settings.json', 'utf8')); } catch (e) { results.settingsRunner = `ERR: ${e.message}`; }

  // 3. Check API key present
  results.apiKeyPresent = !!(config.anthropicApiKey);
  results.apiKeyPrefix = config.anthropicApiKey ? config.anthropicApiKey.substring(0, 10) + '...' : 'MISSING';

  // 4. Run a minimal test as claude_runner (non-root) via su
  try {
    const out = execSync(
      `su -s /bin/bash claude_runner -c 'echo "Say the word HELLO and nothing else." | timeout 30 claude --print --dangerously-skip-permissions 2>&1'`,
      { encoding: 'utf8', timeout: 35000, env: { ...process.env, ANTHROPIC_API_KEY: config.anthropicApiKey, HOME: '/home/claude_runner', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }
    );
    results.testRun = { success: true, output: out.substring(0, 500) };
  } catch (e) {
    results.testRun = { success: false, code: e.status, signal: e.signal, output: (e.stdout || '') + (e.stderr || '') + e.message };
  }

  res.json(results);
});

// ─── Lead Gen ─────────────────────────────────────────────────────────────────

const LEADGEN_TEMPLATE_DIR = path.join(__dirname, 'leadgen', 'templates');

// Helper: resolve the per-client data directory
function clientDir(id) {
  return path.join(CLIENTS_DIR, id);
}

// Seed a file into the client's leadgen dir on first use
function seedLeadgenFile(cDir, filename) {
  const dest = path.join(cDir, 'leadgen', filename);
  if (!fs.existsSync(dest)) {
    const src = path.join(LEADGEN_TEMPLATE_DIR, filename);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  return dest;
}

// GET /api/clients/:id/leadgen/config — returns leadgen-config + personas + coupons + hot-sources
app.get('/api/clients/:id/leadgen/config', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const readJson = (file) => {
    const p = seedLeadgenFile(cDir, file);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };

  res.json({
    config:    readJson('leadgen-config.json'),
    personas:  readJson('personas.json'),
    coupons:   readJson('coupon-config.json'),
    sources:   readJson('hot-sources.json'),
  });
});

// PUT /api/clients/:id/leadgen/config — save one or more config sections
app.put('/api/clients/:id/leadgen/config', requireLicense, (req, res) => {
  const cDir  = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const sections = { config: 'leadgen-config.json', personas: 'personas.json', coupons: 'coupon-config.json', sources: 'hot-sources.json' };
  const body     = req.body;
  const saved    = [];

  for (const [key, filename] of Object.entries(sections)) {
    if (body[key] !== undefined) {
      const dest = path.join(cDir, 'leadgen', filename);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(body[key], null, 2));
      saved.push(key);

      // Sync hot_sources table if sources changed
      if (key === 'sources') {
        try {
          for (const src of body[key]) lgDb.upsertHotSource(cDir, src);
        } catch {}
      }
    }
  }

  res.json({ saved });
});

// GET /api/clients/:id/leadgen/stats
app.get('/api/clients/:id/leadgen/stats', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  try {
    res.json(lgDb.getStats(cDir));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id/leadgen/leads?platform=&stage=&minScore=&converted=&limit=&offset=
app.get('/api/clients/:id/leadgen/leads', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const q = req.query;
  try {
    const leads = lgDb.getLeads(cDir, {
      platform:  q.platform || undefined,
      stage:     q.stage !== undefined ? parseInt(q.stage) : undefined,
      minScore:  q.minScore !== undefined ? parseInt(q.minScore) : undefined,
      converted: q.converted !== undefined ? q.converted === '1' || q.converted === 'true' : undefined,
      limit:     parseInt(q.limit)  || 100,
      offset:    parseInt(q.offset) || 0,
    });
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id/leadgen/leads/:leadId — update stage, mark converted, DND, notes
app.patch('/api/clients/:id/leadgen/leads/:leadId', requireLicense, (req, res) => {
  const cDir   = clientDir(req.params.id);
  const leadId = parseInt(req.params.leadId);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const { action, stage, notes } = req.body;
  try {
    if (action === 'convert') {
      lgDb.markConverted(cDir, leadId);
    } else if (action === 'dnd') {
      lgDb.markDoNotEngage(cDir, leadId);
    } else if (stage !== undefined) {
      lgDb.updateLeadStage(cDir, leadId, stage, { notes });
    } else if (notes !== undefined) {
      lgDb.updateLeadStage(cDir, leadId,
        lgDb.getLeadById(cDir, leadId)?.engagement_stage ?? 0,
        { notes }
      );
    }
    res.json({ ok: true, lead: lgDb.getLeadById(cDir, leadId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id/leadgen/leads/:leadId
app.delete('/api/clients/:id/leadgen/leads/:leadId', requireLicense, (req, res) => {
  const cDir   = clientDir(req.params.id);
  const leadId = parseInt(req.params.leadId);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  try {
    lgDb.deleteLead(cDir, leadId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id/leadgen/next-run — next scheduled lead gen UTC time
app.get('/api/clients/:id/leadgen/next-run', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const cfg   = JSON.parse(fs.readFileSync(path.join(cDir, 'config.json'), 'utf8'));
  const times = cfg.schedule?.leadgen;
  if (!Array.isArray(times) || !times.length) return res.json({ nextRun: null, times: [] });

  const now  = new Date();
  const cur  = now.getUTCHours() * 60 + now.getUTCMinutes();
  const parsed = times.map(t => {
    const [h, m] = t.split(':').map(Number);
    return { hhmm: t, minutes: h * 60 + m };
  }).filter(x => !isNaN(x.minutes)).sort((a, b) => a.minutes - b.minutes);

  const upcoming = parsed.find(t => t.minutes > cur);
  const nextRun  = upcoming ? upcoming.hhmm + ' UTC' : (parsed[0]?.hhmm + ' UTC (+1d)');

  // Days filter
  const days = cfg.leadgenSchedule?.days;
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const daysLabel = Array.isArray(days) && days.length ? days.map(d => DAY_NAMES[d]).join(', ') : 'every day';

  res.json({ nextRun, times, daysLabel, enabled: true });
});

// GET /api/clients/:id/leadgen/log?limit=&offset=
app.get('/api/clients/:id/leadgen/log', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  try {
    res.json(lgDb.getLog(cDir, {
      limit:  parseInt(req.query.limit)  || 50,
      offset: parseInt(req.query.offset) || 0,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backup ───────────────────────────────────────────────────────────────────

// Status: last backup time, size, whether R2 is configured
app.get('/api/backup/status', requireLicense, (req, res) => {
  const status = backup.loadStatus(DATA_DIR);
  res.json({ ...status, r2Configured: backup.isR2Configured() });
});

// ─── Knowledge base per client (products, competitors, hot-sources, keywords, followers) ───
const KNOWLEDGE_SECTIONS = new Set(['products', 'competitors', 'hot-sources', 'keywords', 'followers']);

function knowledgeDir(id) {
  const d = path.join(CLIENTS_DIR, id, 'knowledge');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

app.get('/api/clients/:id/knowledge/:section', requireLicense, (req, res) => {
  const { id, section } = req.params;
  if (!KNOWLEDGE_SECTIONS.has(section)) return res.status(400).json({ error: 'Invalid section' });
  const f = path.join(knowledgeDir(id), `${section}.json`);
  if (!fs.existsSync(f)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { res.json([]); }
});

app.put('/api/clients/:id/knowledge/:section', requireLicense, (req, res) => {
  const { id, section } = req.params;
  if (!KNOWLEDGE_SECTIONS.has(section)) return res.status(400).json({ error: 'Invalid section' });
  if (!fs.existsSync(path.join(CLIENTS_DIR, id))) return res.status(404).json({ error: 'Client not found' });
  const data = Array.isArray(req.body) ? req.body : [];
  fs.writeFileSync(path.join(knowledgeDir(id), `${section}.json`), JSON.stringify(data, null, 2));
  res.json({ success: true, count: data.length });
});

// ─── SMTP test ───
app.post('/api/settings/smtp-test', requireLicense, async (req, res) => {
  const config = loadConfig();
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing to address' });
  try {
    await sendEmail(config, {
      to,
      subject: '[AI Social Pilot] SMTP test',
      text: 'This is a test email from AI Social Pilot. Your SMTP settings are working correctly.',
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger a manual backup now
app.post('/api/backup/run', requireLicense, async (req, res) => {
  try {
    const result = await backup.runBackup(DATA_DIR);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download a full backup as a .tar.gz (or .tar.gz.enc if encrypted)
app.get('/api/backup/download', requireLicense, async (req, res) => {
  try {
    const tmpPath = backup.createDownloadArchive(DATA_DIR);
    const filename = `aisocialpilot-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/gzip');
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(tmpPath); } catch {} });
    stream.on('error', () => { try { fs.unlinkSync(tmpPath); } catch {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore from an uploaded backup file (raw body, max 2 GB)
app.post('/api/backup/restore',
  requireLicense,
  express.raw({ limit: '2gb', type: '*/*' }),
  (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'No file received' });
    }
    try {
      backup.restoreFromBuffer(req.body, DATA_DIR);
      res.json({ success: true, message: 'Restore complete. Restart the server to apply all changes.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Catch-all: serve admin panel ───
app.get('*', (req, res) => {
  const indexFile = fs.existsSync(path.join(__dirname, '../admin/public/index.html'))
    ? path.join(__dirname, '../admin/public/index.html')
    : path.join(__dirname, 'index.html');
  res.sendFile(indexFile);
});

// ─── Start server ───
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Proxy WebSocket upgrades for noVNC live view
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/vnc')) {
    vncProxy.ws(req, socket, head);
  }
});

// Graceful shutdown — let in-flight claude runs finish before exiting
process.on('SIGTERM', () => {
  console.log('  ✦ SIGTERM received — waiting for running jobs to finish');
  server.close(() => process.exit(0));
  // If still running after 25s, force exit (Railway's timeout is 30s)
  setTimeout(() => process.exit(0), 25000);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✦ AI Social Pilot — Admin Panel`);
  console.log(`  ✦ Running on http://0.0.0.0:${PORT}`);
  console.log(`  ✦ Data directory: ${DATA_DIR}`);
  console.log(`  ✦ Live browser view: http://0.0.0.0:${PORT}/vnc/\n`);

  // Initial license check
  const config = loadConfig();
  if (config.licenseKey) {
    validateLicense(config.licenseKey).then(result => {
      config.licenseValid = result.valid;
      config.licenseLastCheck = new Date().toISOString();
      config.licensePlan = result.plan;
      config.maxClients = result.maxClients;
      saveConfig(config);
      console.log(`  ✦ License: ${result.valid ? '✅ Valid' : '❌ Invalid'} (${result.plan || 'none'})\n`);
    });
  }
});
