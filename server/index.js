const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

// Track in-flight automation processes keyed by runId
const runningProcesses = new Map();
// Track active session browser processes keyed by "clientId:platform"
const sessionProcesses = new Map();

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
  const { anthropicApiKey, openaiApiKey, keepAnthropicKey, aiProvider, anthropicModel, openaiModel } = req.body;
  const config = loadConfig();

  // Allow updating without re-entering existing key (Settings page flow)
  const resolvedAnthropicKey = anthropicApiKey || (keepAnthropicKey ? config.anthropicApiKey : '');
  if (!resolvedAnthropicKey) return res.status(400).json({ error: 'Anthropic API key required (needed for browser automation)' });

  config.anthropicApiKey = resolvedAnthropicKey;
  if (openaiApiKey) config.openaiApiKey = openaiApiKey;   // only overwrite if a new key was provided
  config.aiProvider = aiProvider || config.aiProvider || 'anthropic';
  config.anthropicModel = anthropicModel || config.anthropicModel || 'claude-haiku-4-5-20251001';
  config.openaiModel = openaiModel || config.openaiModel || 'gpt-4o-mini';
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

    'ambassador': ctx + `Run ambassador network session.
1. Read ambassadors.json, ambassador-content.json, ambassador-rules.json
2. Find briefs with status = "approved" in ambassador-content.json
3. For each target account in the brief, adapt the caption in that ambassador's voice and niche angle
4. Show ALL adapted captions to the user — do not post without approval
5. Once approved, post with natural staggered timing
6. Run cross-engagement after posts go live`,
  };
  return commands[command] || (ctx + command);
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
  if (!config.anthropicApiKey) {
    return res.status(400).json({ error: 'Anthropic API key not configured. Complete setup first.' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  };

  const runId = crypto.randomBytes(4).toString('hex');
  const startedAt = new Date().toISOString();
  send('start', { runId, command, clientName: clientConfig.name, startedAt });

  const prompt = buildPrompt(command, clientConfig);
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    ANTHROPIC_MODEL: config.anthropicModel || 'claude-haiku-4-5-20251001',
    SOCIALPILOT_PROXY: clientConfig.proxy?.url || '',
    EXPECTED_GEO: clientConfig.proxy?.geo || '',
    CLIENT_ID: clientConfig.clientId,
    // Ensure HOME is set so Claude Code can find/create ~/.claude config dir
    HOME: process.env.HOME || '/root',
    // Disable Claude Code auto-update check (causes issues in containers)
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  // Pre-flight: verify claude CLI is available
  const claudePath = (() => { try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return null; } })();
  if (!claudePath) {
    send('output', { text: '✗ claude CLI not found in PATH. Check Docker build logs.\n' });
    send('done', { code: 1, runId, status: 'failed' });
    res.end();
    return;
  }
  const claudeVersion = (() => { try { return execSync('claude --version 2>&1', { encoding: 'utf8', timeout: 10000 }).trim(); } catch (e) { return `error: ${e.message}`; } })();
  send('output', { text: `> claude: ${claudePath} (${claudeVersion})\n` });

  const t0 = Date.now();

  // Write prompt to a temp file
  const tmpPromptFile = `/tmp/claude-prompt-${runId}.txt`;
  fs.writeFileSync(tmpPromptFile, prompt, { mode: 0o644 });

  // Write a shell script that exports all env vars and runs claude as claude_runner.
  const se = v => `'${String(v || '').replace(/'/g, "'\\''")}'`; // single-quote shell escape
  const tmpScript = `/tmp/claude-run-${runId}.sh`;
  fs.writeFileSync(tmpScript, [
    '#!/bin/bash',
    // Inherit root's PATH so node, playwright, etc. are all findable by claude_runner
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
    // Clear Claude Code session history so each run starts fresh (not continuing previous conversation)
    `rm -rf /home/claude_runner/.claude/projects/ 2>/dev/null || true`,
    `cd ${se(clientDir)}`,
    `cat ${se(tmpPromptFile)} | claude --print --dangerously-skip-permissions`,
  ].join('\n') + '\n', { mode: 0o755 });

  let proc;
  try {
    proc = spawn('/bin/su', ['-s', '/bin/bash', 'claude_runner', '-c', tmpScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    send('error', { text: `Failed to start: ${err.message}` });
    send('done', { code: 1, runId });
    res.end();
    return;
  }

  runningProcesses.set(runId, { proc, clientId: req.params.id, command, startedAt });

  proc.stdout.on('data', chunk => send('output', { text: chunk.toString() }));
  proc.stderr.on('data', chunk => {
    const txt = chunk.toString();
    console.log(`[run ${runId}] stderr: ${txt.substring(0, 200)}`);
    send('progress', { text: txt });
  });
  proc.on('error', err => send('error', { text: `Process error: ${err.message}` }));

  proc.on('close', (code, signal) => {
    // Clean up temp files
    try { fs.unlinkSync(tmpPromptFile); } catch {}
    try { fs.unlinkSync(tmpScript); } catch {}

    runningProcesses.delete(runId);
    const completedAt = new Date().toISOString();
    const status = code === 0 ? 'completed' : code === null ? 'stopped' : 'failed';
    const elapsed = Date.now() - t0;

    if (signal) send('output', { text: `\n[Process killed by signal: ${signal}]\n` });
    console.log(`[run ${runId}] close: code=${code} signal=${signal} elapsed=${elapsed}ms`);

    const logFile = path.join(clientDir, 'logs', 'runs.json');
    let runs = [];
    try { runs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {}
    runs.push({ runId, command, startedAt, completedAt, status, exitCode: code, signal });
    fs.writeFileSync(logFile, JSON.stringify(runs.slice(-100), null, 2));

    send('done', { code, runId, status });
    res.end();
  });

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
        entry.proc.kill('SIGTERM');
        runningProcesses.delete(runId);
      }
    }
  });
});

// ─── Stop a running automation ───
app.post('/api/clients/:id/run/stop', requireLicense, (req, res) => {
  const { runId } = req.body;
  const entry = runningProcesses.get(runId);
  if (!entry || entry.clientId !== req.params.id) {
    return res.status(404).json({ error: 'No running process found' });
  }
  entry.proc.kill('SIGTERM');
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
