const express = require('express');
const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const readline = require('readline');
const backup = require('./backup');
const lgDb           = require('./leadgen/db');
const { buildLeadGenPrompt } = require('./leadgen/prompt');

// ─── Product Image Downloader ─────────────────────────────────────────────────
function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const req = proto.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 30000,
    }, res => {
      // Follow redirects (up to 5)
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
    });
    req.on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Download all images for a client's products in the background.
// Updates products.json with local_url for each downloaded image.
// Writes progress to assets/pull-status.json
async function downloadProductImages(clientId) {
  const kDir      = path.join(CLIENTS_DIR, clientId, 'knowledge');
  const assetsDir = path.join(CLIENTS_DIR, clientId, 'assets', 'products');
  const statusPath= path.join(CLIENTS_DIR, clientId, 'assets', 'pull-status.json');

  fs.mkdirSync(assetsDir, { recursive: true });

  // Load products
  let products = [];
  try { products = JSON.parse(fs.readFileSync(path.join(kDir, 'products.json'), 'utf8')); } catch { return; }

  const status = { running: true, total: 0, done: 0, failed: 0, startedAt: new Date().toISOString() };

  // Count total images to download
  for (const p of products) {
    for (const img of (p.images || [])) {
      if (img.url && !img.local_url) status.total++;
    }
  }
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(status));
  if (status.total === 0) {
    status.running = false; status.finishedAt = new Date().toISOString();
    fs.writeFileSync(statusPath, JSON.stringify(status));
    return;
  }

  // Download each image
  for (let pi = 0; pi < products.length; pi++) {
    const p = products[pi];
    const slug = slugify(p.name) || `product-${pi}`;
    const productDir = path.join(assetsDir, slug);
    fs.mkdirSync(productDir, { recursive: true });

    for (let ii = 0; ii < (p.images || []).length; ii++) {
      const img = p.images[ii];
      if (!img.url || img.local_url) continue; // skip already downloaded

      // Determine file extension from URL
      const urlPath = img.url.split('?')[0];
      const extMatch = urlPath.match(/\.(jpg|jpeg|png|webp|gif)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
      const filename = `image-${ii}.${ext}`;
      const destPath = path.join(productDir, filename);
      const localUrl = `/api/clients/${clientId}/assets/products/${slug}/${filename}`;

      try {
        await downloadFile(img.url, destPath);
        p.images[ii].local_url = localUrl;
        status.done++;
      } catch (e) {
        console.error(`[assets] Failed to download ${img.url}: ${e.message}`);
        status.failed++;
      }
      fs.writeFileSync(statusPath, JSON.stringify(status));
    }
  }

  // Save updated products.json with local_urls
  fs.writeFileSync(path.join(kDir, 'products.json'), JSON.stringify(products, null, 2));

  status.running = false;
  status.finishedAt = new Date().toISOString();
  fs.writeFileSync(statusPath, JSON.stringify(status));
  console.log(`[assets] Image pull complete for ${clientId}: ${status.done} downloaded, ${status.failed} failed`);
}

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

function getGitCommit() {
  try {
    const headPath = path.join(__dirname, '../.git/HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = path.join(__dirname, '../.git', head.slice(5));
      return fs.readFileSync(refPath, 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch { return null; }
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

// ─── Serve locally downloaded product assets ───
app.get('/api/clients/:id/assets/products/:slug/:filename', (req, res) => {
  const filePath = path.join(CLIENTS_DIR, req.params.id, 'assets', 'products', req.params.slug, req.params.filename);
  // Security: ensure path doesn't escape CLIENTS_DIR
  if (!filePath.startsWith(CLIENTS_DIR)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

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
    commit: getGitCommit(),
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
          geminiApiKey, keepGeminiKey,
          smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom,
          resendApiKey, keepResendKey, dailyReportEmail, dailyReportFrom } = req.body;
  const config = loadConfig();

  // Allow updating without re-entering existing key (Settings page flow)
  const resolvedAnthropicKey = anthropicApiKey || (keepAnthropicKey ? config.anthropicApiKey : '');
  if (!resolvedAnthropicKey) return res.status(400).json({ error: 'Anthropic API key required (needed for browser automation)' });

  config.anthropicApiKey = resolvedAnthropicKey;
  if (openaiApiKey) config.openaiApiKey = openaiApiKey;
  // Gemini key (for Precision Content Engine image generation)
  const resolvedGeminiKey = geminiApiKey || (keepGeminiKey ? config.geminiApiKey : '');
  if (resolvedGeminiKey) config.geminiApiKey = resolvedGeminiKey;
  config.aiProvider = aiProvider || config.aiProvider || 'anthropic';
  config.anthropicModel = anthropicModel || config.anthropicModel || 'claude-haiku-4-5-20251001';
  config.openaiModel = openaiModel || config.openaiModel || 'gpt-4o-mini';

  // SMTP (only overwrite if provided)
  if (smtpHost !== undefined) config.smtpHost = smtpHost;
  if (smtpPort !== undefined) config.smtpPort = smtpPort;
  if (smtpUser !== undefined) config.smtpUser = smtpUser;
  if (smtpPass !== undefined) config.smtpPass = smtpPass;
  if (smtpFrom !== undefined) config.smtpFrom = smtpFrom;

  // Resend (daily report)
  const resolvedResendKey = resendApiKey || (keepResendKey ? config.resendApiKey : '');
  if (resolvedResendKey) config.resendApiKey = resolvedResendKey;
  if (dailyReportEmail) config.dailyReportEmail = dailyReportEmail;
  if (dailyReportFrom)  config.dailyReportFrom  = dailyReportFrom;

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
    geminiApiKeyMasked: mask(config.geminiApiKey),
    hasGeminiKey:    !!config.geminiApiKey,
    smtpHost:  config.smtpHost  || '',
    smtpPort:  config.smtpPort  || '587',
    smtpUser:  config.smtpUser  || '',
    smtpFrom:  config.smtpFrom  || '',
    hasSmtp:   !!(config.smtpHost && config.smtpUser && config.smtpPass),
    hasResendKey:     !!(process.env.RESEND_API_KEY || config.resendApiKey),
    resendApiKeyMasked: mask(config.resendApiKey),
    dailyReportEmail: config.dailyReportEmail || process.env.DAILY_REPORT_EMAIL || '',
    dailyReportFrom:  config.dailyReportFrom  || process.env.DAILY_REPORT_FROM  || '',
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
  writeBrandVoiceMd(clientDir, name, brandVoice || {});

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

  // Update brand-voice.md if brand voice or visual identity changed
  if (req.body.brandVoice || req.body.visualIdentity) {
    writeBrandVoiceMd(clientDir, updated.name, updated.brandVoice || {}, updated.visualIdentity || {});
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

  // ── Dedicated precision-post handler ──────────────────────────────────────
  if (command.startsWith('precision-post:')) {
    const briefId = command.slice('precision-post:'.length);
    const clientId2 = clientConfig.clientId;
    const clientDir2 = path.join(CLIENTS_DIR, clientId2);
    const lgDir2 = path.join(clientDir2, 'leadgen');
    const assetsDir2 = path.join(clientDir2, 'assets', 'precision');
    const briefs2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(lgDir2, 'precision-briefs.json'), 'utf8')); } catch { return []; } })();
    const brief2 = briefs2.find(b => b.brief_id === briefId);
    const leads2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(lgDir2, 'leads.json'), 'utf8')); } catch { return []; } })();
    const proxyUrl = clientConfig.proxy?.url || '';
    const expectedGeo = clientConfig.proxy?.geo || '';
    const instagramHandle = clientConfig.platforms?.instagram?.handle || 'the brand account';
    const sessionDir = path.join(clientDir2, 'browser-sessions', 'instagram');
    const screenshotsDir = path.join(clientDir2, 'logs', 'screenshots');

    if (!brief2) {
      return `Brief ${briefId} not found in precision-briefs.json. Nothing to do.`;
    }

    const briefLeads = (brief2.leads || []).map(bl => {
      const username = typeof bl === 'string' ? bl : (bl.username || bl.id || '');
      const lead = leads2.find(l => l.username === username.replace(/^@/, '') || '@' + l.username === username);
      return { username, stage: lead?.engagement_stage ?? 0 };
    });
    const eligibleForDM = briefLeads.filter(l => l.stage >= 3);

    let brandVoice = '';
    try { brandVoice = fs.readFileSync(path.join(clientDir2, 'config', 'brand-voice.md'), 'utf8').slice(0, 600); } catch {}

    return `You are running a PRECISION CONTENT POST session for "${clientConfig.name}".
This is a FOCUSED run — ONE brief to post. No scraping. No pipeline work. Just post this brief to Instagram + DMs.

━━━ PROXY / GEO CHECK (MANDATORY FIRST STEP) ━━━
${proxyUrl ? `Run this EXACT command before opening any browser:
  curl -s -x '${proxyUrl}' --max-time 20 --connect-timeout 15 https://ipinfo.io/json
Verify "country" = "${expectedGeo}". If geo mismatch: STOP and log error.` : 'No proxy configured — proceed without geo check.'}

━━━ BRIEF TO POST ━━━
Brief ID: ${brief2.brief_id}
Topic: ${brief2.cluster_topic}
Format: ${brief2.format}
Caption: ${brief2.caption || brief2.key_message}
Image path: ${brief2.image_url ? assetsDir2 + '/' + (brief2.image_url.split('/').pop()) : 'none — post caption only'}
DM template: ${brief2.dm_template || '(none)'}
Target leads: ${briefLeads.map(l => `${l.username} (stage ${l.stage})`).join(', ') || 'none'}
Eligible for DM (stage ≥ 3): ${eligibleForDM.map(l => l.username).join(', ') || 'none — skip DM step'}

━━━ BRAND VOICE ━━━
${brandVoice || '(not configured)'}

━━━ INSTAGRAM SESSION ━━━
Session dir: ${sessionDir}
Account: ${instagramHandle}

Standard launch pattern:
const { chromium } = require('playwright');
(async () => {
  const opts = { headless: false, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'] };
  ${proxyUrl ? `const pu = new URL('${proxyUrl}'.includes('://') ? '${proxyUrl}' : 'http://${proxyUrl}'); opts.proxy = { server: pu.protocol+'//'+pu.host, username: decodeURIComponent(pu.username||''), password: decodeURIComponent(pu.password||'') };` : ''}
  const context = await chromium.launchPersistentContext('${sessionDir}', opts);
  const page = context.pages()[0] || await context.newPage();
  // ... post logic
})();

━━━ POSTING STEPS ━━━
${brief2.format === 'dm_only' ? 'Format is DM ONLY — skip Instagram posting, go straight to the DM step below.' : `
Write a complete Playwright script to /tmp/run-precision-${brief2.brief_id}.js and run it with node.

KNOWN WORKING INSTAGRAM DOM PATTERNS (use these exactly — do not probe/discover):

  // 1. Open Create dropdown
  await page.locator('svg[aria-label="New post"], a[href="#"][role="link"] svg').first().click();
  await page.waitForTimeout(1500);

  // 2. Click "Post" — must use evaluate() NOT locator.click() (href="#" causes navigation)
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[role="link"]'));
    const post = links.find(l => l.textContent.trim() === 'Post');
    if (post) post.click();
  });
  await page.waitForSelector('div[role="dialog"]', { timeout: 8000 });

  // 3. Upload image — file input is hidden, use setInputFiles() directly
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles('${brief2.image_url ? assetsDir2 + '/' + (brief2.image_url.split('/').pop()) : ''}');
  await page.waitForTimeout(3000); // wait for preview to load

  // 4. Advance through crop/filter/caption screens (click "Next" button each time)
  for (let i = 0; i < 3; i++) {
    const next = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').last();
    if (await next.isVisible({ timeout: 4000 }).catch(() => false)) { await next.click(); await page.waitForTimeout(2000); }
  }

  // 5. Type caption (on the caption screen, before final Share)
  const captionBox = page.locator('div[role="textbox"], textarea[placeholder*="caption"], div[contenteditable="true"]').first();
  if (await captionBox.isVisible({ timeout: 5000 }).catch(() => false)) {
    await captionBox.click();
    await page.keyboard.type('${(brief2.caption || brief2.key_message || '').replace(/'/g, "\\'")}', { delay: 40 });
    await page.waitForTimeout(1500);
  }

  // 6. Click Share — Instagram's Share is a header element, NOT div[role=button]
  // Use JS click via evaluate (most reliable, bypasses overlay intercepts)
  const shared = await page.evaluate(() => {
    const all = [...document.querySelectorAll('div[role="button"], button, span[role="button"], div')];
    const btn = all.find(el => el.textContent.trim() === 'Share' && el.offsetParent !== null);
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!shared) {
    await page.locator(':text-is("Share")').last().click({ force: true });
  }
  await page.waitForTimeout(6000); // wait for post to publish and success screen

  // 7. Verify: navigate to own profile, get post URL from grid
  await page.goto('https://www.instagram.com/${instagramHandle}/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000); // wait for grid to render
  await page.waitForSelector('a[href*="/p/"]', { timeout: 10000 }).catch(() => {});
  const firstPost = page.locator('a[href*="/p/"]').first();
  await firstPost.click();
  await page.waitForTimeout(2000);
  const postUrl = page.url(); // THIS is the real post URL — must start with /p/
  // screenshot
  await page.screenshot({ path: '${screenshotsDir}/posted-${brief2.brief_id}-' + Date.now() + '.png' });

Steps:
1. Open Instagram and verify logged in as ${instagramHandle} — if login prompt: STOP
2. Scroll feed 60s (warmup — do NOT capture any URLs during this)
3. Run the posting sequence above
4. postUrl variable will hold the verified URL — use it when updating the brief`}

━━━ DM STEP ━━━
${eligibleForDM.length === 0 ? 'No eligible leads for DM (none at stage ≥ 3). Skip DM step.' : `
Wait 2-3 min after posting (or immediately if dm_only).
For each eligible lead, navigate to their profile and send DM:
${eligibleForDM.map(l => `  - ${l.username}: "${brief2.dm_template || 'Hello! Thought you might love our bamboo bedding.'}"`).join('\n')}

After each DM:
- Update lead engagement_stage to 6 in: ${lgDir2}/leads.json
  (Read the file, find the lead by username, set engagement_stage=6, updated_at=ISO timestamp, write back)
- Append to outreach log: ${path.join(clientDir2, 'logs', 'outreach-log.ndjson')}
  {"timestamp":"ISO","action_type":"dm","platform":"instagram","username":"@handle","content_used":"message sent","brief_id":"${brief2.brief_id}"}
`}

━━━ UPDATE BRIEF STATUS ━━━
After all steps are done:
1. Read: ${lgDir2}/precision-briefs.json
2. Find brief_id "${brief2.brief_id}"
3. Set fields:
   - status = "posted" (ONLY if you verified the post appeared in ${instagramHandle}'s profile grid)
   - status = "failed" (if posting failed or could not be verified)
   ${brief2.format !== 'dm_only' ? '- post_url = the URL you got from page.url() after clicking the post in YOUR OWN profile grid (must start with https://www.instagram.com/p/)' : ''}
   - posted_at = ISO timestamp
   - amplification_done = true
4. Write the updated JSON back to the file
IMPORTANT: If you are not 100% certain the post was created and you have its real URL from the profile grid, set status="failed" — do not guess.

━━━ SAFETY RULES ━━━
- If Instagram shows "action blocked" or CAPTCHA: STOP, screenshot, log error
- If session asks for login / QR code: STOP and log "session expired — manual login needed"
- NEVER use a URL from the home feed or explore page as the post_url — those are OTHER people's posts
- ONLY set post_url after navigating to ${instagramHandle}'s own profile and clicking the new post
- If you cannot verify the post appeared in the profile grid: set status="failed" not "posted"
- Never DM the same person twice
- Never include a URL in a first DM
- SingletonLock conflict: delete ${sessionDir}/SingletonLock and retry once

━━━ SUMMARY OUTPUT ━━━
Print at the end:
  Brief: ${brief2.brief_id}
  Post status: [posted / failed / dm_only]
  Post URL: [url or N/A]
  DMs sent: [count]
  Brief status updated: [yes/no]
`;
  }
  // ── End precision-post ────────────────────────────────────────────────────

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

    'intercept': (() => {
      const clientDir2 = path.join(CLIENTS_DIR, clientConfig.clientId);
      const interceptCfgPath = path.join(clientDir2, 'intercept', 'intercept-config.json');
      let iCfg = {};
      try { iCfg = JSON.parse(fs.readFileSync(interceptCfgPath, 'utf8')); } catch {}

      if (!iCfg.enabled) return ctx + `INTERCEPT NOT ENABLED.\nInform the user that the Intercept feature is not enabled for this client. They can enable it in the Intercept tab of the client settings.`;

      const competitors = (iCfg.competitors_to_watch || []).filter(Boolean);
      if (!competitors.length) return ctx + `INTERCEPT: No competitors configured to watch. Add competitor handles in the Intercept tab.`;

      const logPath = path.join(clientDir2, 'intercept', 'intercept-log.ndjson');
      const recentLog = (() => {
        try {
          return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-20).map(l => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean);
        } catch { return []; }
      })();

      // Count intercepts per competitor this week
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const weeklyCount = {};
      recentLog.filter(e => e.action === 'comment_posted' && e.timestamp > weekAgo).forEach(e => {
        weeklyCount[e.competitor_account] = (weeklyCount[e.competitor_account] || 0) + 1;
      });

      // Build already-commented post list to avoid duplicates
      const commentedPosts = new Set(recentLog.filter(e => e.action === 'comment_posted').map(e => e.post_url).filter(Boolean));

      const strategies = iCfg.comment_strategies || ['mirror_question', 'shared_experience', 'soft_comparison', 'visual_hook'];
      const brandSearchTerm = iCfg.search_discovery?.brand_search_term || '';
      const ambassadorSearchTerm = iCfg.search_discovery?.ambassador_search_term || '';
      const minDelay = iCfg.comment_delay_min_minutes || 30;
      const maxDelay = iCfg.comment_delay_max_minutes || 90;
      const minComments = iCfg.min_existing_comments || 5;
      const maxPerWeek = iCfg.max_per_competitor_per_week || 3;
      const dmInterval = iCfg.dm_check_interval_minutes || 15;
      const humanReviewThreshold = iCfg.dm_human_review_overlap_threshold || 3;

      const skipCompetitors = competitors.filter(c => (weeklyCount[c] || 0) >= maxPerWeek);
      const activeCompetitors = competitors.filter(c => (weeklyCount[c] || 0) < maxPerWeek);

      return ctx + `You are running a Competitor Audience Intercept session. This is the highest-converting engagement strategy — you monitor competitor posts, find pain-point conversations, and post natural adjacent comments to attract interested people to DM you.

━━━ GOLDEN RULES (never break these) ━━━
• NEVER mention the brand name in a competitor's comment section — ever
• NEVER reply directly to a specific person — post independent comments only
• NEVER bash or criticize the competitor by name
• NEVER use hashtags, links, or @ mentions in intercept comments
• NEVER comment immediately after a post goes up — wait the configured delay
• If an account shows a restriction or CAPTCHA: STOP and log, do not proceed

━━━ INTERCEPT CONFIG ━━━
Competitors to watch: ${activeCompetitors.join(', ') || 'NONE (all at weekly limit)'}
${skipCompetitors.length ? `AT WEEKLY LIMIT (skip): ${skipCompetitors.join(', ')}` : ''}
Comment delay: ${minDelay}-${maxDelay} minutes after post
Min comments in thread before posting: ${minComments}
Max intercepts per competitor per week: ${maxPerWeek}
DM inbox check interval: every ${dmInterval} minutes
Enabled comment strategies: ${strategies.join(', ')}

━━━ SEARCH DISCOVERY TERMS (for DM Stage 4 only) ━━━
Brand search term: "${brandSearchTerm}"
Ambassador search term: "${ambassadorSearchTerm}"
→ Guide people to search, never send direct links

━━━ STEP 1 — SCAN COMPETITOR POSTS ━━━
For each active competitor (${activeCompetitors.join(', ')}):
1. Open their Instagram and/or TikTok profile using Playwright (headed, headless:false)
2. Find posts from the last 24-48 hours
3. For each post, evaluate:
   a. Is it relevant to the product category? Skip: giveaways, hiring, birthdays, unrelated
   b. How long ago was it posted? Skip if less than ${minDelay} minutes ago
   c. Count comments — skip if fewer than ${minComments}
   d. Already commented? Skip these post URLs: ${commentedPosts.size ? [...commentedPosts].slice(-10).join(', ') : 'none yet'}
   e. Opportunity score: do the post content or comments match any pain-point keywords?
4. Pick the best 1-2 qualifying posts per competitor to intercept
5. Screenshot the post + existing comments before acting

━━━ STEP 2 — ANALYZE THE POST ━━━
For each qualifying post:
1. Read the post caption carefully — what pain point or product is it about?
2. Read the top 10-15 comments — what are people saying? Any frustration, questions, or interest?
3. Map it to your product's matching benefit from the brand intelligence below
4. Decide which comment strategy fits best:
   - mirror_question: post is about a pain point, commenters are relating to it → ask a genuine question about the same pain point
   - shared_experience: promo post, positive vibe → seed that you found a solution (vague, no brand name)
   - soft_comparison: negative comments about competitor quality → hint at better alternative without naming it
   - visual_hook: lifestyle/product image post → post a comment with a relevant product lifestyle image (if ${strategies.includes('visual_hook') ? 'ENABLED' : 'DISABLED'})

━━━ STEP 3 — POST THE COMMENT ━━━
Write and post your intercept comment:
• Under 150 characters
• Written as a genuine person — natural, casual, first-person
• One emotion only: curious / reflective / helpful (don't mix)
• No marketing language whatsoever
• Wait a random delay between ${minDelay} and ${maxDelay} minutes before posting
• Screenshot immediately after posting (save to logs/screenshots/intercept-{timestamp}.png)
• Log: { action: "comment_posted", competitor_account, post_url, comment_strategy, comment_text, timestamp }

Comment strategy examples for this brand:
mirror_question → "Does anyone here actually find [product type] helps with [pain point from keywords]? I've been struggling with this for months 😩"
shared_experience → "I switched mine about a month ago and honestly didn't realize how much the old one was [pain point] until I did. Completely different now."
soft_comparison → "Same issue here — I found [product feature] matters way more than [what competitor emphasizes]. The one I ended up with [benefit], it changed everything."
visual_hook → post comment with lifestyle image: "This is the [feature] that actually worked for me 👆" [no product name or brand visible in image]

━━━ STEP 4 — CHECK DM INBOX ━━━
After posting, check DM inbox on all active account sessions:
1. Identify new DMs received since last check
2. For each new DM, determine:
   - Is this person asking about a comment I posted? (look for "your comment", "you mentioned", questions about what you found)
   - Is this a known follower from the database? (check follower overlap for priority)
   - What stage are they at? (first contact / mid-conversation / ready to buy)
3. Flag for human review if: follower overlap score ≥ ${humanReviewThreshold}, or they're a large influencer (check their profile)

━━━ DM CONVERSION FLOW ━━━
Stage 1 — They reach out
  → Acknowledge warmly. Ask their specific situation: "What's been bothering you most — is it [pain point A] or more [pain point B]?"
  → Goal: make them feel they're getting personal advice, not a pitch

Stage 2 — Genuine advice (NO product pitch yet)
  → Answer their specific pain point with real, helpful information
  → Ask follow-up: sleep position, how long they've had the issue, what they've tried
  → Goal: build trust before any mention of product

Stage 3 — Natural product introduction + image
  → "The one that actually worked for me is called [PRODUCT NAME]"
  → Send the best lifestyle product image (no branding visible if possible)
  → Explain why it matches their specific situation (reference what they told you)
  → Goal: show don't tell

Stage 4 — Search discovery (never send a direct link)
  → "I don't have the link saved but just Google '${brandSearchTerm || '[BRAND SEARCH TERM]'}' — comes right up"
  → "If you want the review that convinced me, search '${ambassadorSearchTerm || '[AMBASSADOR SEARCH TERM]'}' on YouTube"
  → Goal: they arrive at the product through their own search = higher intent, higher trust

━━━ LOGGING ━━━
After every action, append JSON to logs/intercept/intercept-log.ndjson:
{
  "timestamp": "[ISO 8601]",
  "competitor_account": "@handle",
  "post_url": "url or null",
  "action": "comment_posted | dm_received | dm_replied | dm_flagged_human | post_skipped",
  "comment_strategy": "mirror_question | shared_experience | soft_comparison | visual_hook | null",
  "comment_text": "text or null",
  "dm_username": "@handle or null",
  "dm_stage": 1-4 or null,
  "skip_reason": "reason if skipped or null",
  "screenshot": "filename or null"
}

Output a summary at the end: how many posts scanned, how many intercepted, how many DMs handled.`;
    })(),
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

// ─── Hunt Settings helpers ─────────────────────────────────────────────────────

const HUNT_SETTINGS_DEFAULTS = {
  schedule: {
    enabled: false,
    days: ['monday','wednesday','friday'],
    time_utc: '09:00',
    max_competitors_per_run: 2,
    stagger_minutes_between_competitors: 20,
  },
  safety: {
    warmup_days: 14,
    warmup_multiplier: 0.4,
    daily_limits: {
      instagram: { follows: 50, likes: 100, comments: 15, dms: 10 },
      tiktok:    { follows: 30, likes: 80,  comments: 10, dms: 5  },
    },
    session_limits: { follows: 15, likes: 30, comments: 5, dms: 3 },
    delays: {
      between_actions_ms:  [3000, 8000],
      between_profiles_sec:[30, 90],
      after_comment_min:   [5, 10],
      after_dm_min:        [10, 15],
    },
  },
};

function getHuntSettings(clientId) {
  const f = path.join(CLIENTS_DIR, clientId, 'leadgen', 'hunt-settings.json');
  try {
    const stored = JSON.parse(fs.readFileSync(f, 'utf8'));
    // Deep merge with defaults so missing keys fall back safely
    const sched  = { ...HUNT_SETTINGS_DEFAULTS.schedule,  ...(stored.schedule  || {}) };
    const safety = { ...HUNT_SETTINGS_DEFAULTS.safety,    ...(stored.safety    || {}) };
    safety.daily_limits   = { ...HUNT_SETTINGS_DEFAULTS.safety.daily_limits,   ...(stored.safety?.daily_limits   || {}) };
    safety.session_limits = { ...HUNT_SETTINGS_DEFAULTS.safety.session_limits, ...(stored.safety?.session_limits || {}) };
    safety.delays         = { ...HUNT_SETTINGS_DEFAULTS.safety.delays,         ...(stored.safety?.delays         || {}) };
    safety.daily_limits.instagram = { ...HUNT_SETTINGS_DEFAULTS.safety.daily_limits.instagram, ...(stored.safety?.daily_limits?.instagram || {}) };
    safety.daily_limits.tiktok    = { ...HUNT_SETTINGS_DEFAULTS.safety.daily_limits.tiktok,    ...(stored.safety?.daily_limits?.tiktok    || {}) };
    return { schedule: sched, safety };
  } catch {
    return JSON.parse(JSON.stringify(HUNT_SETTINGS_DEFAULTS));
  }
}

function getHuntBudget(clientId) {
  const f = path.join(CLIENTS_DIR, clientId, 'leadgen', 'hunt-daily-budget.json');
  const todayUTC = new Date().toISOString().slice(0, 10);
  const empty = {
    date: todayUTC,
    accounts: {
      instagram: { follows: 0, likes: 0, comments: 0, dms: 0 },
      tiktok:    { follows: 0, likes: 0, comments: 0, dms: 0 },
    },
  };
  try {
    const stored = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (stored.date !== todayUTC) {
      // New day — reset counters
      const reset = { ...empty, date: todayUTC };
      fs.writeFileSync(f, JSON.stringify(reset, null, 2));
      return reset;
    }
    return stored;
  } catch {
    return empty;
  }
}

function saveHuntBudget(clientId, budget) {
  const f = path.join(CLIENTS_DIR, clientId, 'leadgen', 'hunt-daily-budget.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(budget, null, 2));
}

// ─── AI Intelligence Research ─────────────────────────────────────────────────

// Build a research prompt for one of 4 intel commands.
// All prompts end with [INTEL_DATA_START]...[INTEL_DATA_END] instructions so
// the server can extract structured JSON from Claude's output.
function buildIntelPrompt(command, params, clientConfig, clientId) {
  const knowledgeCtx = buildKnowledgeContext(clientId);

  const wrapperNote = `
IMPORTANT OUTPUT FORMAT: After completing your research/analysis, output your findings as valid JSON between these exact markers (nothing else on those lines):
[INTEL_DATA_START]
{ ... JSON here ... }
[INTEL_DATA_END]

Show your research progress before the markers. Narrate each step you take.
`;

  if (command === 'products-scrape') {
    const storeUrl   = params.storeUrl   || '';
    const keyword    = params.keyword    || '';
    const maxCount   = parseInt(params.maxCount) || 20;
    const extraUrls  = (params.extraUrls || '').split('\n').map(s => s.trim()).filter(Boolean);

    return `You are a product intelligence agent. Your task: extract products from an ecommerce store.

CRITICAL RULE: Print a plain-text status line BEFORE every action. Do not write code silently.
The user is watching a live terminal — keep them informed at every step.

${storeUrl ? `Store URL: ${storeUrl}` : ''}
${extraUrls.length ? `Specific product URLs:\n${extraUrls.map(u => '  ' + u).join('\n')}` : ''}
${keyword ? `Keyword filter: "${keyword}"` : 'No keyword filter.'}
Max products: ${maxCount}

NARRATION RULES (follow exactly):
- Before writing any code: print "⏳ Writing browser script to open [URL]..."
- After launching browser: the script must console.log "🌐 Browser opened, loading [URL]..."
- After page loads: console.log "✅ Page loaded — scanning for product links..."
- When trying a new URL path: console.log "🔍 Trying [URL]..."
- When a product link is found: console.log "📦 Found product: [name]"
- Before scraping each product: console.log "⬇ Scraping [N]/${maxCount}: [name]"
- On any error: console.log "⚠ Error: [message]"
- When done: print "✅ Scrape complete — found [N] products"

STEPS:
1. Print "⏳ Writing browser script to open ${storeUrl || 'store'}..." then write a Playwright script to:
   - Launch headed browser (headless:false, --no-sandbox, --disable-setuid-sandbox)
   - Navigate to the store URL
   - Wait for networkidle or 15s timeout
   - Scroll the page slowly to trigger lazy-loaded content (500px steps, 300ms between)
   - Log the number of <a> tags found
   - Save the script to /tmp/scrape-init.js and run it with node

2. Print "🔍 Looking for product listing pages..." then try these paths in order:
   - The current URL
   - /collections/all, /shop, /products
   - /ar/collections/all, /en/collections/all
   - Any nav link containing: shop, products, متجر, منتجات, تسوق
   - Print each URL being tried before navigating to it

3. For each product found (up to ${maxCount}):
   - Print "⬇ Scraping product [N]/${maxCount}: [name]" before opening each page
   - Wait for page load + scroll to load images
   - Extract: name, price, URL, description (strip HTML tags)

   IMAGE EXTRACTION — STRICT RULES:
   ⚠ NEVER construct, guess, or infer image URLs from product names or handles. Only use URLs you actually read from the page or API.
   ⚠ If you cannot find a real image URL, leave images: [] — an empty array is correct. A fake URL is always wrong.
   ⚠ NEVER reuse an image URL from a previously scraped product. Every product must have its own distinct image URLs.
   ⚠ After scraping all products, check: if any two products share the same image URL, you made an error. Re-scrape those products.

   For EACH product, independently extract its images using this priority order:
   a) Shopify JSON API — for the current product's page URL (e.g. https://store.com/products/some-handle),
      extract the handle from the URL path, then fetch: [store_origin]/products/[that-handle].json
      (NOT a generic URL — the handle must match THIS specific product)
      Parse the JSON. Use product.images[].src — these are guaranteed real URLs.
      console.log("API images for [product name]: " + JSON.stringify(images)) to confirm they are unique.
   b) If API returns 404 or no images: navigate to the product's own page and read the HTML for <img> tags:
      Selectors: .product__media img, .product-gallery img, [data-product-single-media-wrapper] img, .product__photo img, .product-images img
      Use page.evaluate() to get the actual rendered src attribute — NOT innerHTML parsing.
      Only include src values that start with "http" and contain "cdn.shopify.com" or the store's domain.
   c) JSON-LD: page.evaluate() to find <script type="application/ld+json"> containing "@type":"Product" — use the "image" field.
   d) If still nothing found: leave images: [] — do NOT copy images from another product.

   - Collect up to 4 verified image URLs per product (must be unique across products)
   - Generate 4-6 pain_points in English
   - Generate 3-4 pain_points in Gulf Arabic dialect (UAE casual)
   - Generate 4-6 usps (unique selling points)
   - Generate keywords for social monitoring (EN + AR)
   - Screenshot to logs/screenshots/intel-product-{n}.png

4. If 0 products found after all attempts: print "❌ Could not find product listings. Possible reasons: login required, JS-only site, or different URL structure." and output empty data array.

${knowledgeCtx ? 'Current brand context:\n' + knowledgeCtx : ''}
${wrapperNote}
Output JSON schema:
[INTEL_DATA_START]
{
  "section": "products",
  "data": [
    {
      "name": "Product Name",
      "price": "299 SAR",
      "url": "https://...",
      "category": "Ergonomic Sleep",
      "description": "Short description",
      "pain_points": ["morning neck stiffness", "تيبس الرقبة الصباحي (Gulf: عنقي ما زين الصبح)", "..."],
      "usps": ["Benefit 1", "Benefit 2"],
      "keywords": ["keyword 1", "keyword 2", "كلمة مفتاحية"],
      "images": [{"url": "https://cdn.../img.jpg", "social_ready": true, "type": "lifestyle"}]
    }
  ]
}
[INTEL_DATA_END]`;
  }

  if (command === 'competitor-research') {
    const compName  = params.name      || '';
    const storeUrl  = params.storeUrl  || '';
    const instagram = params.instagram || '';
    const tiktok    = params.tiktok    || '';
    const xHandle   = params.x         || '';

    return `You are a competitive intelligence agent. Research this competitor thoroughly and extract actionable leads.

Competitor: ${compName || 'unknown'}
${storeUrl  ? `Store URL: ${storeUrl}` : ''}
${instagram ? `Instagram: ${instagram}` : ''}
${tiktok    ? `TikTok: ${tiktok}` : ''}
${xHandle   ? `X/Twitter: ${xHandle}` : ''}

STEPS using Playwright (headed, headless:false):

STEP 1 — Store crawl (if store URL given):
- Visit their catalog and product pages
- For each of the top 5 products: note the exact product name, page URL, main product image URL, price, and short description
- Read 15-30 customer reviews. Extract the EXACT complaint phrases customers use, and note any reviewers who left a username/handle

STEP 2 — Instagram (if handle given):
- Visit the profile. Scroll to see last 20 posts.
- For each post: open it and read the FIRST 10-15 comments
- Look for comments that express frustration, complaints, comparisons, questions about returns/price/quality
- For each such comment: note the commenter's Instagram username (@handle), the post URL, and what they said
- Also note which products get the most engagement and which hashtags appear in captions

STEP 3 — TikTok (if handle given): same as Instagram — visit profile, open top 10 videos, read comments, extract complainers by @handle

STEP 4 — X/Twitter (if handle given): scan recent replies to their posts, extract usernames who complained

STEP 5 — Compile everything:
- top_products: objects with name, url, image_url, price, description
- weaknesses: objects with text (the complaint theme) and source_url (page or post where found)
- complaint_keywords: exact phrases (strings)
- complaint_users: people who publicly complained — each with username, platform, profile_url (if known), post_url (the post they commented on), complaint_text (what they said), keyword_matched
- hashtags, engagement_patterns, notes (competitive brief)

IMPORTANT: complaint_users are HOT LEADS — they have already expressed frustration with the competitor publicly. Extract as many as possible (aim for 10-20).

6. Screenshot key pages to logs/screenshots/intel-competitor-${compName}.png

${knowledgeCtx ? 'Our current brand context:\n' + knowledgeCtx : ''}
${wrapperNote}
[INTEL_DATA_START]
{
  "section": "competitors",
  "data": {
    "name": "${compName}",
    "website": "${storeUrl}",
    "instagram": "${instagram}",
    "tiktok": "${tiktok}",
    "x": "${xHandle}",
    "top_products": [
      {"name": "Product A", "url": "https://...", "image_url": "https://...", "price": "AED 450", "description": "100% cotton, 600TC"}
    ],
    "promoted_products": ["Product C"],
    "weaknesses": [
      {"text": "Complaint theme 1", "source_url": "https://..."}
    ],
    "complaint_keywords": ["phrase 1", "phrase 2"],
    "complaint_users": [
      {"username": "@user123", "platform": "instagram", "profile_url": "https://instagram.com/user123", "post_url": "https://instagram.com/p/...", "complaint_text": "Their return policy is terrible...", "keyword_matched": "non-returnable"}
    ],
    "hashtags": ["#hashtag1"],
    "engagement_patterns": "Short-form video on TikTok gets 3x more engagement than static posts",
    "notes": "Competitive brief: ...",
    "enabled": true
  }
}
[INTEL_DATA_END]`;
  }

  if (command === 'sources-discover') {
    return `You are a source intelligence agent. Discover where the target audience talks, buys, and makes decisions.

${knowledgeCtx ? 'Brand intelligence to base your research on:\n' + knowledgeCtx : 'No products or competitors loaded yet — do general research for the brand.'}

RESEARCH TASKS (use browser + search engines, no need for Playwright for all of these):
1. Search Reddit for subreddits where people discuss the product category and related problems
2. Find relevant Facebook Groups (search FB for related topics)
3. Identify Instagram/TikTok accounts that are opinion leaders in this niche (not competitors — adjacent influencers)
4. Find relevant hashtags with active communities (search Instagram, TikTok, Twitter)
5. Identify competitor traffic sources: what platforms/sites link to competitor stores?
6. Find any relevant YouTube channels, forums, or review sites
7. For the Middle East/Gulf region specifically: find Arabic-language communities and accounts

For each source rate:
- audience_relevance: 1-10 (how closely does their audience match our target buyer?)
- purchase_decision_likelihood: high/medium/low (does this community lead to buying decisions?)

Focus on QUALITY over quantity. Return 10-20 high-value sources.
${wrapperNote}
[INTEL_DATA_START]
{
  "section": "hot-sources",
  "data": [
    {
      "type": "community",
      "platform": "reddit",
      "handle_or_url": "r/subredditname",
      "why": "Active buyers discuss X here — 3 recommendation threads/week",
      "audience_relevance": 9,
      "purchase_decision_likelihood": "high",
      "enabled": true
    }
  ]
}
[INTEL_DATA_END]`;
  }

  if (command === 'keywords-research') {
    const includeArabic = params.includeArabic !== false;

    return `You are a keyword intelligence agent for social media monitoring.

${knowledgeCtx ? 'Brand intelligence:\n' + knowledgeCtx : 'No products or competitors loaded yet.'}

Generate 30-50 high-value monitoring keywords across these categories:

1. PAIN POINT keywords — phrases people use when expressing the problem (intent: pain-point)
   Example: "my neck hurts every morning", "tired of bad sleep"

2. SOLUTION SEEKING keywords — searching for a solution type (intent: commercial)
   Example: "best pillow for neck pain", "orthopedic pillow review"

3. PURCHASE INTENT keywords — ready to buy (intent: transactional)
   Example: "where to buy cervical pillow in UAE", "pillow free shipping Saudi"

4. COMPETITOR MENTION keywords — mentioning competing brands (intent: navigational)
   Example: "[CompetitorBrand] review", "is [CompetitorBrand] worth it"

5. GENERAL TOPIC keywords — broad category conversations (intent: informational)
   Example: "how to improve sleep quality", "sleep tips"

${includeArabic ? `
6. For EACH category, add Arabic variants across dialects:
   - Gulf (UAE/Saudi/Kuwait/Bahrain): e.g. "وش أحسن مخدة" / "وين أشتري مخدة طبية"
   - Levantine (Lebanon/Syria/Jordan/Palestine): e.g. "شو أحسن مخدة" / "كيف بطلع وجع رقبتي"
   - Egyptian: e.g. "إيه أحسن مخدة" / "فين أشتري مخدة طبية"
   Add transliteration in parentheses for reference: "وش أحسن مخدة (Gulf: wesh ahsen makhada)"
` : ''}

For each keyword:
- intent: transactional | commercial | pain-point | informational | navigational
- volume: high | medium | low (estimated social media frequency)
- platforms: which platforms to watch for this
- relevance_score: 1-10
- notes: brief note on when/how to use this keyword in engagement

${wrapperNote}
[INTEL_DATA_START]
{
  "section": "keywords",
  "data": [
    {
      "keyword": "my neck hurts every morning",
      "intent": "pain-point",
      "volume": "high",
      "platforms": ["instagram", "tiktok", "x", "reddit"],
      "relevance_score": 9,
      "notes": "Engage immediately with empathy + solution hint"
    }
  ]
}
[INTEL_DATA_END]`;
  }

  if (command === 'competitor-hunt') {
    // Targeted audience hunt for a single competitor — results go straight to leads.json
    const { buildLeadGenPrompt } = require('./leadgen/prompt');
    const clientConfig2 = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, clientId, 'config.json'), 'utf8'));
    const basePrompt = buildLeadGenPrompt(clientConfig2, DATA_DIR);

    const name      = params.name      || 'Competitor';
    const instagram = params.instagram || '';
    const tiktok    = params.tiktok    || '';
    const x         = params.x         || '';

    const sources = [
      instagram ? `- [instagram] competitor: ${instagram}` : '',
      tiktok    ? `- [tiktok]    competitor: ${tiktok}` : '',
      x         ? `- [x]         competitor: ${x}` : '',
    ].filter(Boolean).join('\n') || `(no social handles configured for ${name})`;

    // Load hunt settings for safety limits
    const huntSettings = getHuntSettings(clientId);
    const sl = huntSettings.safety.session_limits;
    const delays = huntSettings.safety.delays;
    const warmupDays = huntSettings.safety.warmup_days;
    const warmupMult = huntSettings.safety.warmup_multiplier;
    const effectiveFollows   = Math.floor(sl.follows   * warmupMult);
    const effectiveLikes     = Math.floor(sl.likes     * warmupMult);
    const effectiveComments  = Math.floor(sl.comments  * warmupMult);
    const effectiveDMs       = Math.floor(sl.dms       * warmupMult);

    const safetyBlock = `
━━━ SAFETY LIMITS (enforce strictly) ━━━
Session hard limits (do NOT exceed in this run):
  Follows: ${sl.follows}
  Likes: ${sl.likes}
  Comments: ${sl.comments}
  DMs: ${sl.dms}

Delays:
  Between actions: ${delays.between_actions_ms[0]}–${delays.between_actions_ms[1]}ms (randomise)
  Between profiles: ${delays.between_profiles_sec[0]}–${delays.between_profiles_sec[1]}s (randomise)
  After commenting: ${delays.after_comment_min[0]}–${delays.after_comment_min[1]} minutes
  After DM: ${delays.after_dm_min[0]}–${delays.after_dm_min[1]} minutes

Warmup: account is in warmup period (${warmupDays} days). Apply ${warmupMult}× to ALL limits above.
  → Effective follows: ${effectiveFollows}, likes: ${effectiveLikes}, comments: ${effectiveComments}, dms: ${effectiveDMs}

HARD STOP triggers (stop immediately, screenshot, write error to log):
  - Any "unusual activity" or "action blocked" popup
  - CAPTCHA or checkpoint screen
  - Follow/like silently failing 3+ times in a row
  - Any account restriction warning`;

    // Inject a focused override at the start — overrides the HOT SOURCES section
    return `${basePrompt}

━━━ HUNT OVERRIDE ━━━
This is a TARGETED hunt for ONE competitor: ${name}
IGNORE all other sources from the HOT SOURCES section above.
ONLY scrape audience from these accounts for this run:
${sources}

For each discovered user: set source_handle = "${instagram || tiktok || x || name}" in leads.json.
After scraping, work PHASE B pipeline steps for any existing leads from this competitor (source_handle matches).
Do NOT touch leads from other sources in this run.
${safetyBlock}`;
  }

  // Fallback
  return `Research intelligence for: ${command}\nParams: ${JSON.stringify(params)}\n${wrapperNote}`;
}

// Extract JSON data from Claude/OpenAI output
// Tries: [INTEL_DATA_START]...[INTEL_DATA_END] markers first,
// then ```json blocks, then raw {"section":...} pattern
function parseIntelData(text) {
  // Method 1: explicit markers
  const start = text.indexOf('[INTEL_DATA_START]');
  const end   = text.indexOf('[INTEL_DATA_END]');
  if (start !== -1 && end !== -1 && end > start) {
    const json = text.slice(start + '[INTEL_DATA_START]'.length, end).trim();
    try { return JSON.parse(json); }
    catch (e) { console.error('[intel] Marker JSON parse error:', e.message, '— raw:', json.slice(0, 200)); }
  }

  // Method 2: ```json code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && parsed.section) return parsed;
    } catch (e) { console.error('[intel] Code block JSON parse error:', e.message); }
  }

  // Method 3: find raw JSON object with "section" key
  const rawMatch = text.match(/\{\s*"section"\s*:\s*"[^"]+"\s*,\s*"data"\s*:\s*\[[\s\S]*\]\s*\}/);
  if (rawMatch) {
    try { return JSON.parse(rawMatch[0]); }
    catch (e) { console.error('[intel] Raw JSON parse error:', e.message); }
  }

  console.error('[intel] No parseable JSON found in output (length=' + text.length + ')');
  return null;
}

// Save extracted intel data to knowledge files and auto-propagate to dependent sections
function applyIntelData(clientId, parsed) {
  if (!parsed || !parsed.section) return false;
  const kDir = knowledgeDir(clientId);
  const { section, data } = parsed;

  const readArr = file => { try { return JSON.parse(fs.readFileSync(path.join(kDir, file), 'utf8')); } catch { return []; } };
  const writeArr = (file, arr) => fs.writeFileSync(path.join(kDir, file), JSON.stringify(arr, null, 2));

  if (section === 'products') {
    const existing = readArr('products.json');
    const incoming = Array.isArray(data) ? data : [data];
    // Merge: update by URL if exists, else append
    for (const p of incoming) {
      const idx = existing.findIndex(e => e.url && e.url === p.url);
      if (idx >= 0) existing[idx] = { ...existing[idx], ...p };
      else existing.push(p);
    }
    writeArr('products.json', existing);

    // Auto-propagate: add keywords extracted from products
    const kws = readArr('keywords.json');
    for (const prod of incoming) {
      for (const kw of (prod.keywords || [])) {
        if (!kws.find(k => k.keyword === kw)) {
          kws.push({ keyword: kw, intent: 'commercial', volume: 'medium',
            platforms: ['instagram','tiktok'], relevance_score: 7,
            notes: `Auto-generated from product: ${prod.name}` });
        }
      }
    }
    writeArr('keywords.json', kws);
    return true;
  }

  if (section === 'competitors') {
    const existing = readArr('competitors.json');
    const comp = Array.isArray(data) ? data : [data];
    const normName = n => (n||'').toLowerCase().replace(/\s+/g,' ').trim();
    // Normalise: top_products & weaknesses may be strings or objects — keep as-is
    for (const c of comp) {
      // Match by normalized name OR by website/instagram to avoid duplicates from typos
      const idx = existing.findIndex(e =>
        normName(e.name) === normName(c.name) ||
        (c.website && e.website && e.website === c.website) ||
        (c.instagram && e.instagram && e.instagram === c.instagram)
      );
      if (idx >= 0) existing[idx] = { ...existing[idx], ...c };
      else existing.push(c);
    }
    writeArr('competitors.json', existing);

    // Auto-propagate complaint_keywords → keywords tab
    const kws = readArr('keywords.json');
    for (const c of comp) {
      for (const ck of (c.complaint_keywords || [])) {
        const kw = typeof ck === 'string' ? ck : ck.text || ck.keyword || '';
        if (kw && !kws.find(k => k.keyword === kw)) {
          kws.push({ keyword: kw, intent: 'pain-point', volume: 'medium',
            platforms: ['instagram','tiktok','x'],
            relevance_score: 8, notes: `Competitor complaint keyword: ${c.name}` });
        }
      }
      // Auto-propagate competitor social handles → hot-sources
      const sources = readArr('hot-sources.json');
      if (c.instagram && !sources.find(s => s.handle_or_url === c.instagram)) {
        sources.push({ type: 'account', platform: 'instagram', handle_or_url: c.instagram,
          why: `Competitor account — monitor comments for engagement opportunities`, enabled: true });
      }
      if (c.tiktok && !sources.find(s => s.handle_or_url === c.tiktok)) {
        sources.push({ type: 'account', platform: 'tiktok', handle_or_url: c.tiktok,
          why: `Competitor account — monitor comments for engagement opportunities`, enabled: true });
      }
      writeArr('hot-sources.json', sources);

      // Auto-add complaint_users as hot leads in the leadgen pipeline
      const cDir = path.join(CLIENTS_DIR, clientId);
      let newLeadsAdded = 0;
      for (const u of (c.complaint_users || [])) {
        if (!u.username || !u.platform) continue;
        try {
          lgDb.upsertLead(cDir, {
            platform:      u.platform,
            username:      u.username.replace(/^@/, ''),
            profile_url:   u.profile_url || null,
            display_name:  u.display_name || null,
            total_score:   85, // complaint leads are hot — high score
            is_influencer: 0,
            source_type:   'competitor_complaint',
            source_handle: c.instagram || c.tiktok || c.name || '',
            notes: `Complained about ${c.name}: "${(u.complaint_text || '').slice(0, 120)}" — post: ${u.post_url || 'unknown'}`,
          });
          newLeadsAdded++;
        } catch (e) { console.error('[intel] upsertLead error:', e.message); }
      }
      if (newLeadsAdded > 0) console.log(`[intel] Auto-added ${newLeadsAdded} complaint leads for ${c.name}`);
    }
    writeArr('keywords.json', kws);
    return true;
  }

  if (section === 'hot-sources') {
    const existing = readArr('hot-sources.json');
    const incoming = Array.isArray(data) ? data : [data];
    for (const s of incoming) {
      if (!existing.find(e => e.handle_or_url === s.handle_or_url)) existing.push(s);
    }
    writeArr('hot-sources.json', existing);
    return true;
  }

  if (section === 'keywords') {
    const existing = readArr('keywords.json');
    const incoming = Array.isArray(data) ? data : [data];
    for (const k of incoming) {
      if (!existing.find(e => e.keyword === k.keyword)) existing.push(k);
    }
    writeArr('keywords.json', existing);
    return true;
  }

  return false;
}

// ─── Shared run spawn logic ───
// onData(line) receives output lines; onClose(runId, code, signal, startedAt) is called on exit.
// Returns { runId, proc } or throws if preflight fails.
// promptOverride: if set, skip buildPrompt() and use this string directly.
function spawnRun(clientId, command, onData, onClose, promptOverride = null) {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const config = loadConfig();
  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));

  const runId = crypto.randomBytes(4).toString('hex');
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const prompt = promptOverride !== null ? promptOverride : buildPrompt(command, clientConfig);
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    // Browser-heavy commands need a stronger model; text-only can use the configured (cheaper) model
    ANTHROPIC_MODEL: ['leadgen', 'outreach', 'reply-instagram', 'reply-tiktok'].includes(command) || command.startsWith('precision-post')
      ? 'claude-sonnet-4-6'
      : (config.anthropicModel || 'claude-haiku-4-5-20251001'),
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
    `export NODE_PATH=${se(process.env.NODE_PATH || '/app/node_modules')}`,
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
    `cat ${se(tmpPromptFile)} | claude --output-format stream-json --verbose --dangerously-skip-permissions 2>&1`,
  ].join('\n') + '\n', { mode: 0o755 });

  const proc = spawn('/bin/su', ['-s', '/bin/bash', 'claude_runner', '-c', tmpScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runningProcesses.set(runId, { proc, clientId, command, startedAt, recentLines: [], lastActivity: '' });

  const model = env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const inputTokens = charsToTokens(prompt.length);
  let outputChars = 0;
  // Accumulate full run output for later review
  const runLogsDir = path.join(clientDir, 'logs', 'runs');
  try { fs.mkdirSync(runLogsDir, { recursive: true }); } catch {}
  const runLogFile = path.join(runLogsDir, `${runId}.log`);
  const runLogStream = fs.createWriteStream(runLogFile, { flags: 'a' });
  runLogStream.write(`=== Run ${runId} | ${command} | ${startedAt} ===\n\n`);

  // stream-json outputs JSONL: one JSON object per line as events happen
  // We parse each line and forward the text content; fall back to raw if not valid JSON
  const runEntry = runningProcesses.get(runId);
  let _streamBuf = '';
  proc.stdout.on('data', chunk => {
    _streamBuf += chunk.toString();
    const lines = _streamBuf.split('\n');
    _streamBuf = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        // stream-json event types: system, assistant, result, tool_use, tool_result
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) {
              outputChars += block.text.length;
              _lastOutputAt = Date.now();
              onData('output', block.text);
              runLogStream.write(block.text);
              // Buffer for live status
              if (runEntry) {
                runEntry.recentLines.push(block.text.trim());
                if (runEntry.recentLines.length > 30) runEntry.recentLines.shift();
                runEntry.lastActivity = block.text.trim().substring(0, 200);
                runEntry.lastActivityAt = Date.now();
              }
            } else if (block.type === 'tool_use') {
              // Show which tool and a summary of what it's doing
              const desc = block.input?.description || block.input?.command?.split('\n')[0] || '';
              const label = desc ? `[${block.name}: ${desc.substring(0, 80)}]` : `[${block.name}]`;
              onData('progress', label + '\n');
              runLogStream.write(label + '\n');
              // Buffer for live status
              if (runEntry) {
                runEntry.lastActivity = label;
                runEntry.lastActivityAt = Date.now();
                runEntry.recentLines.push(label);
                if (runEntry.recentLines.length > 30) runEntry.recentLines.shift();
              }
            }
          }
        } else if (ev.type === 'result' && ev.result) {
          // Final result text
          outputChars += ev.result.length;
          onData('output', ev.result);
          runLogStream.write('\n\n=== FINAL RESULT ===\n' + ev.result + '\n');
          if (runEntry) {
            runEntry.lastActivity = 'Completed — writing summary';
            runEntry.lastActivityAt = Date.now();
          }
        }
      } catch {
        // Not JSON (e.g. error output) — forward as-is
        outputChars += line.length;
        onData('output', line + '\n');
        runLogStream.write(line + '\n');
      }
    }
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

    runLogStream.write(`\n=== END | status:${status} exitCode:${code} cost:$${cost_usd?.toFixed(4)} completedAt:${completedAt} ===\n`);
    runLogStream.end();

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

  return { runId, proc, startedAt, startedAtMs, clientConfig };
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

// ─── OpenAI Intel — server-side fetch + OpenAI enrichment (no Claude CLI needed) ───
// For products-scrape: fetch Shopify JSON API directly, then ask OpenAI to generate pain points/USPs/keywords
// For other intel: send prompt directly to OpenAI (text-only, no browser)
const OPENAI_INTEL_COMMANDS = new Set(['products-scrape', 'competitor-research', 'sources-discover', 'keywords-research']);

async function fetchProductData(url) {
  // Try Shopify JSON API first, then fall back to HTML meta tags
  const tryFetch = (u) => new Promise((resolve, reject) => {
    const proto = u.startsWith('https') ? https : http;
    proto.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AISocialPilot/1.0)' }, timeout: 15000 }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return tryFetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });

  // Extract product handle from URL path
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);
  const productsIdx = pathParts.indexOf('products');
  const handle = productsIdx >= 0 ? pathParts[productsIdx + 1] : pathParts[pathParts.length - 1];

  // Try Shopify JSON API
  const jsonUrl = `${urlObj.origin}/products/${handle}.json`;
  try {
    const resp = await tryFetch(jsonUrl);
    if (resp.status === 200) {
      const json = JSON.parse(resp.data);
      if (json.product) {
        const p = json.product;
        return {
          name: p.title,
          handle,
          price: p.variants?.[0]?.price || '',
          currency: '', // will be enriched from store or set to AED
          url,
          description: (p.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          images: (p.images || []).slice(0, 4).map(img => img.src),
          vendor: p.vendor || '',
          tags: p.tags ? (typeof p.tags === 'string' ? p.tags.split(',').map(t=>t.trim()) : p.tags) : [],
          variants: (p.variants || []).map(v => ({ title: v.title, price: v.price, available: v.available })),
        };
      }
    }
  } catch {}

  // Fallback: fetch HTML and extract meta tags
  try {
    const resp = await tryFetch(url);
    if (resp.status === 200) {
      const html = resp.data;
      const meta = (name) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i')); return m?.[1] || ''; };
      const jsonLd = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      let ldProduct = null;
      if (jsonLd) try { const ld = JSON.parse(jsonLd[1]); if (ld['@type'] === 'Product') ldProduct = ld; } catch {}

      return {
        name: meta('og:title') || meta('twitter:title') || (ldProduct?.name) || handle,
        handle,
        price: meta('og:price:amount') || (ldProduct?.offers?.price) || '',
        currency: meta('og:price:currency') || (ldProduct?.offers?.priceCurrency) || '',
        url,
        description: meta('og:description') || meta('description') || (ldProduct?.description) || '',
        images: [meta('og:image')].filter(Boolean).slice(0, 4),
        vendor: '',
        tags: [],
        variants: [],
      };
    }
  } catch {}

  return { name: handle, handle, price: '', currency: '', url, description: '', images: [], vendor: '', tags: [], variants: [] };
}

async function runOpenAIIntel(clientId, command, params, onData, onClose) {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const config = loadConfig();
  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDir, 'config.json'), 'utf8'));

  if (!config.openaiApiKey) throw new Error('OpenAI API key not configured');

  const runId = crypto.randomBytes(4).toString('hex');
  const startedAt = new Date().toISOString();
  const model = config.openaiModel || 'gpt-4o-mini';

  const controller = new AbortController();
  runningProcesses.set(runId, { clientId, command, startedAt, abort: controller });

  let accOutput = '';
  let usageTokens = null;
  let status = 'completed';
  const emit = (type, text) => { if (type === 'output') accOutput += text; onData(type, text); };

  emit('output', `> Provider: OpenAI (${model}) — no browser needed\n\n`);

  let prompt;

  if (command === 'products-scrape') {
    const storeUrl = params.storeUrl || '';
    const keyword = params.keyword || '';
    const maxCount = parseInt(params.maxCount) || 20;
    const extraUrls = (params.extraUrls || '').split('\n').map(s => s.trim()).filter(Boolean);

    // Step 1: Fetch product data server-side
    const urlsToFetch = [...extraUrls];
    if (storeUrl && !extraUrls.length) {
      // Try to discover product URLs from store
      emit('output', `🔍 Discovering products from ${storeUrl}...\n`);
      try {
        const tryPaths = ['/products.json', '/collections/all/products.json'];
        for (const p of tryPaths) {
          try {
            const origin = new URL(storeUrl).origin;
            const resp = await new Promise((resolve, reject) => {
              const proto = origin.startsWith('https') ? https : http;
              proto.get(origin + p, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve({ status: res.statusCode, data }));
              }).on('error', reject);
            });
            if (resp.status === 200) {
              const json = JSON.parse(resp.data);
              const products = json.products || [];
              for (const prod of products.slice(0, maxCount)) {
                const prodUrl = `${origin}/products/${prod.handle}`;
                if (!keyword || prod.title.toLowerCase().includes(keyword.toLowerCase()) || (prod.tags||'').toLowerCase().includes(keyword.toLowerCase())) {
                  urlsToFetch.push(prodUrl);
                }
              }
              if (urlsToFetch.length) {
                emit('output', `✅ Found ${urlsToFetch.length} products from store API\n`);
                break;
              }
            }
          } catch {}
        }
      } catch {}
      if (!urlsToFetch.length) {
        emit('output', `⚠ Could not discover products automatically. Please provide specific URLs.\n`);
      }
    }

    if (!urlsToFetch.length) {
      emit('output', `❌ No product URLs to scrape.\n`);
      runningProcesses.delete(runId);
      if (onClose) onClose(runId, 1, null, startedAt, 'failed');
      return { runId, startedAt };
    }

    emit('output', `\n📦 Fetching ${urlsToFetch.length} product(s)...\n`);
    const products = [];
    for (let i = 0; i < Math.min(urlsToFetch.length, maxCount); i++) {
      const url = urlsToFetch[i];
      emit('output', `⬇ [${i+1}/${Math.min(urlsToFetch.length, maxCount)}] ${url}\n`);
      try {
        const data = await fetchProductData(url);
        products.push(data);
        emit('output', `  ✅ ${data.name} — ${data.price || 'no price'} — ${data.images.length} images\n`);
      } catch (e) {
        emit('output', `  ⚠ Failed: ${e.message}\n`);
      }
    }

    if (!products.length) {
      emit('output', `\n❌ Could not fetch any products.\n`);
      runningProcesses.delete(runId);
      if (onClose) onClose(runId, 1, null, startedAt, 'failed');
      return { runId, startedAt };
    }

    // Step 2: Enrich via OpenAI in batches of 4 (avoids token limit truncation)
    const BATCH_SIZE = 4;
    const knowledgeCtx = buildKnowledgeContext(clientId);
    const allEnriched = [];
    const batches = [];
    for (let i = 0; i < products.length; i += BATCH_SIZE) batches.push(products.slice(i, i + BATCH_SIZE));

    emit('output', `\n🤖 Enriching ${products.length} product(s) via ${model} in ${batches.length} batch(es)...\n`);

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      emit('output', `\n📦 Batch ${b+1}/${batches.length} (${batch.length} products)...\n`);

      const batchPrompt = `You are a product intelligence agent. Enrich these ${batch.length} product(s) with marketing data.

For each product, generate:
- pain_points: 4-6 in English + 3-4 in Gulf Arabic dialect (UAE casual)
- usps: 4-6 unique selling points
- keywords: social monitoring keywords in English + Arabic
- category: product category
- A clean short description if the original is too long

${knowledgeCtx ? 'Brand context:\n' + knowledgeCtx + '\n' : ''}
Products:
${JSON.stringify(batch, null, 2)}

CRITICAL: Return ONLY a JSON array — no markdown, no code blocks, no explanation.
The response must be ONLY this (nothing before or after):
[
  {
    "name": "Product Name",
    "price": "299",
    "currency": "AED",
    "url": "https://...",
    "category": "Category",
    "description": "Short description",
    "pain_points": ["english point", "(Gulf: arabic point)"],
    "usps": ["Benefit 1", "Benefit 2"],
    "keywords": ["keyword1", "كلمة"],
    "images": [{"url": "https://cdn.../img.jpg", "social_ready": true, "type": "product"}]
  }
]

Rules:
- Use ACTUAL image URLs from the data — never invent
- Each product has its OWN images
- Gulf Arabic = everyday UAE dialect
- Default currency: AED`;

      let batchOutput = '';
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.openaiApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 16000,
            messages: [
              { role: 'system', content: 'You are a JSON-only API. Return raw JSON arrays only. Never use markdown formatting or code blocks.' },
              { role: 'user', content: batchPrompt },
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`OpenAI API error ${response.status}: ${errText}`);
        }

        const result = await response.json();
        batchOutput = result.choices?.[0]?.message?.content || '';
        if (result.usage) {
          usageTokens = usageTokens || { input: 0, output: 0 };
          usageTokens.input += result.usage.prompt_tokens || 0;
          usageTokens.output += result.usage.completion_tokens || 0;
        }
        if (result.choices?.[0]?.finish_reason === 'length') {
          emit('output', `  ⚠ Response truncated (hit token limit)\n`);
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        emit('output', `  ⚠ Batch ${b+1} error: ${err.message}\n`);
        continue;
      }

      // Parse batch result — try JSON array directly
      let batchData = null;
      const cleaned = batchOutput.trim().replace(/^```(?:json)?\s*\n?/,'').replace(/\n?```\s*$/,'').trim();
      try {
        batchData = JSON.parse(cleaned);
      } catch (e) {
        // Try to find array in output
        const arrMatch = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (arrMatch) try { batchData = JSON.parse(arrMatch[0]); } catch {}
      }

      if (Array.isArray(batchData) && batchData.length > 0) {
        allEnriched.push(...batchData);
        emit('output', `  ✅ Got ${batchData.length} enriched product(s)\n`);
      } else {
        emit('output', `  ⚠ Could not parse batch ${b+1} response (${batchOutput.length} chars)\n`);
        console.error(`[intel] Batch ${b+1} parse fail — first 500 chars:`, batchOutput.slice(0, 500));
        console.error(`[intel] Batch ${b+1} parse fail — last 500 chars:`, batchOutput.slice(-500));
      }
    }

    // Build final result
    if (allEnriched.length > 0) {
      // Inject into accOutput so parseIntelData can find it
      const finalJson = JSON.stringify({ section: 'products', data: allEnriched });
      emit('output', `\n[INTEL_DATA_START]\n${finalJson}\n[INTEL_DATA_END]\n`);
      emit('output', `\n✅ Total: ${allEnriched.length} products enriched\n`);
    } else {
      emit('output', `\n❌ No products could be enriched\n`);
    }
  } else {
    // For other intel commands, build the standard prompt and send to OpenAI
    prompt = buildIntelPrompt(command, params, clientConfig, clientId);

    // Single-call path for non-product commands
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errText}`);
      }

      const result = await response.json();
      const content = result.choices?.[0]?.message?.content || '';
      if (content) emit('output', content);
      if (result.usage) {
        usageTokens = { input: result.usage.prompt_tokens || 0, output: result.usage.completion_tokens || 0 };
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        status = 'stopped';
        emit('output', '\n[Stopped by user]\n');
      } else {
        status = 'failed';
        emit('output', `\n❌ OpenAI error: ${err.message}\n`);
      }
    }
  }

  runningProcesses.delete(runId);
  const completedAt = new Date().toISOString();

  // Extract structured data from output
  let extracted = false, extractedSection = null, extractedCount = 0;
  if (status === 'completed') {
    const parsed = parseIntelData(accOutput);
    if (parsed) {
      try {
        applyIntelData(clientId, parsed);
        extracted = true;
        extractedSection = parsed.section;
        extractedCount = Array.isArray(parsed.data) ? parsed.data.length : 1;
        emit('output', `\n\n✅ Saved ${extractedCount} items to ${extractedSection}\n`);
      } catch (e) {
        emit('output', `\n⚠ Failed to save data: ${e.message}\n`);
      }
    } else {
      emit('output', '\n⚠ No data markers found in AI response\n');
    }
  }

  // Log cost
  const inputTokens = usageTokens?.input ?? charsToTokens(accOutput.length);
  const outputTokens = usageTokens?.output ?? charsToTokens(accOutput.length);
  const cost_usd = estimateCost(model, inputTokens, outputTokens);

  const logFile = path.join(clientDir, 'logs', 'runs.json');
  let runs = [];
  try { runs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {}
  runs.push({ runId, command, startedAt, completedAt, status, provider: 'openai', model,
    cost_usd, input_tokens: inputTokens, output_tokens: outputTokens });
  fs.writeFileSync(logFile, JSON.stringify(runs.slice(-100), null, 2));

  checkAndSendBudgetAlert(config, clientConfig).catch(() => {});

  if (onClose) onClose(runId, status === 'completed' ? 0 : 1, null, startedAt, status === 'completed' ? 'completed' : status);
  return { runId, startedAt };
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

  // Never kill a running process when the SSE connection drops.
  // Runs always continue to completion — the client can reconnect and see results in the Runs tab.
  req.on('close', () => {
    const elapsed = Date.now() - t0;
    console.log(`[run ${runId}] req.close at ${elapsed}ms — run continues in background`);
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
  intercept: 'intercept',
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

// ─── Hunt scheduler ─────────────────────────────────────────────────────────────
// Tracks already-triggered hunt runs: "clientId:competitorName:YYYY-MM-DD:HH:MM"
const huntRunsTriggered = new Set();
let _huntLastClearDate = '';

// Maps day index (0=Sun…6=Sat) to lowercase name
const DOW_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function fireScheduledHunt(clientId, comp, huntSettings) {
  const cLogsDir = path.join(CLIENTS_DIR, clientId, 'logs');
  if (!fs.existsSync(cLogsDir)) fs.mkdirSync(cLogsDir, { recursive: true });
  const schedLogFile = path.join(cLogsDir, 'scheduled.log');
  const logLine = text => { try { fs.appendFileSync(schedLogFile, text); } catch {} };

  const params = {
    name:      comp.name      || 'Competitor',
    instagram: comp.instagram || '',
    tiktok:    comp.tiktok    || '',
    x:         comp.x         || '',
  };
  const intelPrompt = buildIntelPrompt('competitor-hunt', params, {}, clientId);

  logLine(`\n[${new Date().toISOString()}] Hunt scheduled: ${comp.name} (priority: ${comp.hunt_priority || 'normal'})\n`);

  try {
    spawnRun(
      clientId,
      'competitor-hunt',
      (type, text) => { if (type === 'output' || type === 'error') logLine(text); },
      (runId, code, signal, startedAt, status) => {
        logLine(`\n[${new Date().toISOString()}] Hunt finished: ${comp.name} runId=${runId} status=${status} code=${code}\n`);
        console.log(`[hunt-scheduler] Hunt finished: ${comp.name} clientId=${clientId} runId=${runId} status=${status}`);
        // Append to hunt-history.json with scheduled:true
        try {
          const huntLogPath = path.join(CLIENTS_DIR, clientId, 'leadgen', 'hunt-history.json');
          let history = [];
          try { history = JSON.parse(fs.readFileSync(huntLogPath, 'utf8')); } catch {}
          history.unshift({
            runId,
            competitorName: comp.name,
            status,
            startedAt,
            finishedAt: new Date().toISOString(),
            scheduled: true,
          });
          if (history.length > 50) history = history.slice(0, 50);
          fs.writeFileSync(huntLogPath, JSON.stringify(history, null, 2));
        } catch (e) { console.error('[hunt-scheduler] hunt-history write error:', e.message); }
      },
      intelPrompt
    );
  } catch (err) {
    logLine(`\n[${new Date().toISOString()}] Hunt FAILED to start for ${comp.name}: ${err.message}\n`);
    console.error(`[hunt-scheduler] Failed to start hunt for ${comp.name}:`, err.message);
  }
}

setInterval(() => {
  const now = new Date();
  const todayUTC  = now.toISOString().slice(0, 10);
  const currentHHMM = now.toISOString().slice(11, 16);
  const todayDOW  = DOW_NAMES[now.getUTCDay()];

  // Daily reset
  if (_huntLastClearDate && _huntLastClearDate !== todayUTC) {
    huntRunsTriggered.clear();
    console.log('[hunt-scheduler] Daily reset — cleared triggered set');
  }
  _huntLastClearDate = todayUTC;

  const config = loadConfig();
  if (!config.anthropicApiKey) return;

  const clients = getClients();
  for (const client of clients) {
    if (client.status === 'paused') continue;

    let huntSettings;
    try { huntSettings = getHuntSettings(client.clientId); } catch { continue; }

    const sched = huntSettings.schedule;
    if (!sched.enabled) continue;
    if (!Array.isArray(sched.days) || !sched.days.includes(todayDOW)) continue;
    if (sched.time_utc !== currentHHMM) continue;

    const triggerKey = `${client.clientId}:hunt:${todayUTC}:${currentHHMM}`;
    if (huntRunsTriggered.has(triggerKey)) continue;

    // Load competitors for this client
    const kDir = path.join(CLIENTS_DIR, client.clientId, 'knowledge');
    let competitors = [];
    try { competitors = JSON.parse(fs.readFileSync(path.join(kDir, 'competitors.json'), 'utf8')); } catch { continue; }

    // Filter out disabled and off-priority
    competitors = competitors.filter(c => c.enabled !== false && (c.hunt_priority || 'normal') !== 'off');
    if (!competitors.length) continue;

    // Sort by priority: high first
    competitors.sort((a, b) => {
      const rank = { high: 0, normal: 1 };
      return (rank[a.hunt_priority || 'normal'] || 1) - (rank[b.hunt_priority || 'normal'] || 1);
    });

    // Take up to max_competitors_per_run
    const maxComp = sched.max_competitors_per_run || 2;
    const toHunt = competitors.slice(0, maxComp);

    // Budget check — skip if follows budget exhausted for any platform used
    const budget = getHuntBudget(client.clientId);
    const dl = huntSettings.safety.daily_limits;

    const eligibleComps = toHunt.filter(comp => {
      const platforms = [comp.instagram && 'instagram', comp.tiktok && 'tiktok'].filter(Boolean);
      for (const plat of platforms) {
        const used = budget.accounts[plat];
        const limit = dl[plat];
        if (used && limit && used.follows >= limit.follows) {
          console.log(`[hunt-scheduler] Skipping ${comp.name} — follows budget exhausted for ${plat}`);
          return false;
        }
      }
      return true;
    });

    if (!eligibleComps.length) {
      console.log(`[hunt-scheduler] No eligible competitors for ${client.clientId} — budget exhausted`);
      continue;
    }

    huntRunsTriggered.add(triggerKey);
    console.log(`[hunt-scheduler] Triggering hunt for ${client.clientId}: ${eligibleComps.map(c=>c.name).join(', ')}`);

    // Fire hunts staggered
    const staggerMs = (sched.stagger_minutes_between_competitors || 20) * 60000;
    eligibleComps.forEach((comp, i) => {
      if (i === 0) {
        fireScheduledHunt(client.clientId, comp, huntSettings);
      } else {
        setTimeout(() => {
          fireScheduledHunt(client.clientId, comp, huntSettings);
        }, i * staggerMs);
      }
    });
  }
}, 60000);

// ─── Daily report via Resend (06:00 GST = 02:00 UTC) ─────────────────────────
// Collect yesterday + month-to-date stats for all clients, send HTML email via Resend API.

function buildClientReport(clientId, clientName, yesterday, monthPrefix) {
  const cDir  = path.join(CLIENTS_DIR, clientId);
  let leads = [];
  try { leads = lgDb.getLeads(cDir, { limit: 99999 }); } catch {}

  const active = leads.filter(l => !l.is_do_not_engage);

  // Yesterday — new leads
  const newYesterday = active.filter(l => (l.created_at || '').startsWith(yesterday));
  // Yesterday — stage advancements (updated but not created same day, or any updated)
  const advancedYesterday = active.filter(l =>
    (l.updated_at || '').startsWith(yesterday) && l.engagement_stage > 0
  );
  // Yesterday — DMs attempted
  const dmsYesterday = active.filter(l =>
    (l.updated_at || '').startsWith(yesterday) && l.dm_pivot_attempted
  );

  // Runs yesterday
  const runs = getClientRuns(clientId);
  const runsYesterday = runs.filter(r => (r.startedAt || '').startsWith(yesterday));
  const runsSuccess   = runsYesterday.filter(r => r.status === 'completed').length;
  const runsFailed    = runsYesterday.filter(r => r.status === 'failed' || r.status === 'error').length;

  // MTD (month to date)
  const mtdLeads      = active.filter(l => (l.created_at || '').startsWith(monthPrefix));
  const mtdConverted  = leads.filter(l => l.is_converted && (l.converted_at || l.updated_at || '').startsWith(monthPrefix));
  const mtdDms        = leads.filter(l => l.dm_pivot_attempted && (l.updated_at || '').startsWith(monthPrefix));
  const mtdRuns       = runs.filter(r => (r.startedAt || '').startsWith(monthPrefix));

  // Platform breakdown (yesterday new leads)
  const platMap = {};
  for (const l of newYesterday) platMap[l.platform] = (platMap[l.platform] || 0) + 1;
  const platBreakdown = Object.entries(platMap).map(([p, n]) => `${p}: ${n}`).join(', ') || 'none';

  // Stage distribution today (total pipeline)
  const STAGE_LABELS = ['New','Story Viewed','Liked','Followed','Commented','DM Sent','DM Replied','Converted'];
  const stageDist = STAGE_LABELS.map((label, i) =>
    `${label}: ${active.filter(l => l.engagement_stage === i).length}`
  ).join(' · ');

  return {
    clientName,
    newYesterday: newYesterday.length,
    platBreakdown,
    advancedYesterday: advancedYesterday.length,
    dmsYesterday: dmsYesterday.length,
    runsYesterday: runsYesterday.length,
    runsSuccess,
    runsFailed,
    totalLeads: active.length,
    hotLeads: active.filter(l => l.total_score >= 70).length,
    converted: leads.filter(l => l.is_converted).length,
    mtdLeads: mtdLeads.length,
    mtdConverted: mtdConverted.length,
    mtdDms: mtdDms.length,
    mtdRuns: mtdRuns.length,
    stageDist,
  };
}

function buildDailyReportHtml(reports, dateLabel, monthLabel) {
  const rows = reports.map(r => `
    <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:20px 24px;margin-bottom:20px">
      <h2 style="margin:0 0 16px;font-size:16px;color:#e4e4e7;font-weight:600">${escapeHtmlEmail(r.clientName)}</h2>

      <p style="margin:0 0 10px;font-size:13px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Yesterday · ${dateLabel}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px">
        <tr>
          ${kpiCell('New Leads', r.newYesterday, r.newYesterday > 0 ? '#22c55e' : '#71717a')}
          ${kpiCell('Advanced', r.advancedYesterday, '#60a5fa')}
          ${kpiCell('DMs Sent', r.dmsYesterday, '#c084fc')}
          ${kpiCell('Runs', `${r.runsSuccess}✓${r.runsFailed > 0 ? ' ' + r.runsFailed + '✗' : ''}`, r.runsFailed > 0 ? '#f87171' : '#4ade80')}
        </tr>
      </table>
      ${r.newYesterday > 0 ? `<p style="margin:0 0 14px;font-size:12px;color:#71717a">Sources: ${escapeHtmlEmail(r.platBreakdown)}</p>` : ''}

      <p style="margin:0 0 10px;font-size:13px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Month to Date · ${monthLabel}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px">
        <tr>
          ${kpiCell('New Leads', r.mtdLeads, '#60a5fa')}
          ${kpiCell('DMs Sent', r.mtdDms, '#c084fc')}
          ${kpiCell('Converted', r.mtdConverted, '#4ade80')}
          ${kpiCell('Runs', r.mtdRuns, '#f59e0b')}
        </tr>
      </table>

      <p style="margin:0 0 6px;font-size:13px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Total Pipeline</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px">
        <tr>
          ${kpiCell('All Leads', r.totalLeads, '#e4e4e7')}
          ${kpiCell('Hot (≥70)', r.hotLeads, '#f59e0b')}
          ${kpiCell('Converted', r.converted, '#4ade80')}
          ${kpiCell('', '', '')}
        </tr>
      </table>
      <p style="margin:8px 0 0;font-size:11px;color:#52525b;line-height:1.6">${escapeHtmlEmail(r.stageDist)}</p>
    </div>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Social Pilot — Daily Report</title></head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:0 auto;padding:32px 16px">
  <div style="text-align:center;margin-bottom:28px">
    <p style="margin:0;font-size:11px;color:#52525b;text-transform:uppercase;letter-spacing:.1em">AI Social Pilot</p>
    <h1 style="margin:8px 0 4px;font-size:22px;color:#f4f4f5;font-weight:700">Daily Report</h1>
    <p style="margin:0;font-size:13px;color:#71717a">${dateLabel} · Delivered 6:00 AM GST</p>
  </div>
  ${rows}
  <div style="text-align:center;margin-top:24px;padding-top:20px;border-top:1px solid #27272a">
    <p style="margin:0;font-size:11px;color:#3f3f46">AI Social Pilot · aisocialpilot.com</p>
  </div>
</div>
</body></html>`;
}

function kpiCell(label, value, color) {
  if (!label) return `<td width="25%" style="padding:4px"></td>`;
  return `<td width="25%" style="padding:4px">
    <div style="background:#09090b;border:1px solid #27272a;border-radius:8px;padding:10px 12px;text-align:center">
      <div style="font-size:20px;font-weight:700;color:${color || '#e4e4e7'}">${value}</div>
      <div style="font-size:10px;color:#71717a;margin-top:2px">${label}</div>
    </div>
  </td>`;
}

function escapeHtmlEmail(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function sendResendEmail({ apiKey, from, to, subject, html }) {
  const body = JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html });
  return new Promise((resolve, reject) => {
    const req = require('https').request(
      { hostname: 'api.resend.com', path: '/emails', method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                   'Content-Length': Buffer.byteLength(body) } },
      res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
          else reject(new Error(`Resend ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendDailyReport(targetClientId) {
  const config = loadConfig();
  const apiKey = process.env.RESEND_API_KEY || config.resendApiKey;
  if (!apiKey) throw new Error('[daily-report] Missing RESEND_API_KEY');

  const now         = new Date();
  const ystDate     = new Date(now.getTime() - 86400000);
  const yesterday   = ystDate.toISOString().slice(0, 10);
  const monthPrefix = now.toISOString().slice(0, 7);
  const dateLabel   = ystDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });
  const monthLabel  = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' });

  const allClients = getClients().filter(c => c.status !== 'paused');
  const targets    = targetClientId ? allClients.filter(c => (c.clientId || c.id) === targetClientId) : allClients;

  if (!targets.length) throw new Error('[daily-report] No matching clients');

  // Group clients by recipient email — one email per recipient containing all their clients
  const byRecipient = {};
  for (const c of targets) {
    const to   = c.dailyReportEmail || '';
    const from = c.dailyReportFrom  || `AI Social Pilot <reports@adsbackup.com>`;
    if (!to) { console.log(`[daily-report] Skipping ${c.name} — no recipient email set (configure in client Settings tab)`); continue; }
    if (!byRecipient[to]) byRecipient[to] = { from, clients: [] };
    byRecipient[to].clients.push(c);
  }

  if (!Object.keys(byRecipient).length) throw new Error('No clients have a recipient email configured. Set it in each client\'s Settings tab.');

  for (const [to, { from, clients }] of Object.entries(byRecipient)) {
    const reports = clients.map(c => buildClientReport(c.clientId || c.id, c.name, yesterday, monthPrefix));
    const html    = buildDailyReportHtml(reports, dateLabel, monthLabel);
    const subject = `Daily Report — ${dateLabel}`;
    await sendResendEmail({ apiKey, from, to, subject, html });
    console.log(`[daily-report] Sent to ${to} (${clients.map(c => c.name).join(', ')})`);
  }
}

// ─── Nightly backup at 02:00 UTC ─────────────────────────────────────────────
setInterval(() => {
  const hhmm = new Date().toISOString().slice(11, 16);
  if (hhmm === '02:00') {
    backup.runBackup(DATA_DIR).catch(err =>
      console.error('[backup] Nightly backup failed:', err.message)
    );
    sendDailyReport(); // 02:00 UTC = 06:00 GST
  }
}, 60000);

// ─── Smart Auto-Schedule for leadgen ─────────────────────────────────────────
// GST = UTC+4. Converts GST "HH:MM" to total UTC minutes since midnight.
function gstHhmmToUtcMin(gstHHMM) {
  const [h, m] = gstHHMM.split(':').map(Number);
  return (((h * 60 + m) - 240) + 1440) % 1440;
}
function utcMinToHhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function utcHhmmToGstHhmm(utcHHMM) {
  const [h, m] = utcHHMM.split(':').map(Number);
  return utcMinToHhmm((h * 60 + m + 240) % 1440);
}

// Generate one random UTC "HH:MM" per window. Windows are GST local time.
function generateSmartScheduleTimes(windows) {
  const times = [];
  for (const win of (windows || [])) {
    if (!win.startGst || !win.endGst) continue;
    const startMin = gstHhmmToUtcMin(win.startGst);
    const endMin   = gstHhmmToUtcMin(win.endGst);
    const range    = endMin > startMin ? endMin - startMin : (1440 - startMin) + endMin;
    if (range <= 0) continue;
    times.push(utcMinToHhmm((startMin + Math.floor(Math.random() * range)) % 1440));
  }
  return times.sort();
}

// Write freshly-generated times into client config + schedule.leadgen
function applySmartSchedule(clientId) {
  const cfgPath = path.join(CLIENTS_DIR, clientId, 'config.json');
  if (!fs.existsSync(cfgPath)) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return; }
  const ss = cfg.smartSchedule;
  if (!ss || !ss.enabled) return;

  const todayUTC = new Date().toISOString().slice(0, 10);
  const times = generateSmartScheduleTimes(ss.windows || []);
  cfg.smartSchedule.todayTimes    = times;
  cfg.smartSchedule.generatedDate = todayUTC;
  cfg.schedule = cfg.schedule || {};
  cfg.schedule.leadgen = times;
  try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch {}
  console.log(`[smart-schedule] ${clientId}: ${times.join(', ')} UTC`);
}

// At midnight UTC regenerate all smart schedules for the new day
let _smartSchedLastDate = '';
setInterval(() => {
  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10);
  const hhmm     = now.toISOString().slice(11, 16);
  if (hhmm === '00:00' && _smartSchedLastDate !== todayUTC) {
    _smartSchedLastDate = todayUTC;
    console.log('[smart-schedule] Midnight — regenerating smart schedules');
    try { getClients().forEach(c => applySmartSchedule(c.clientId || c.id)); } catch {}
  }
}, 60000);

// On startup: generate schedule for any client that hasn't had one today
(() => {
  try {
    const todayUTC = new Date().toISOString().slice(0, 10);
    getClients().forEach(c => {
      const ss = c.smartSchedule;
      if (ss && ss.enabled && ss.generatedDate !== todayUTC) {
        applySmartSchedule(c.clientId || c.id);
      }
    });
  } catch {}
})();

// ─── Smart-schedule API ───────────────────────────────────────────────────────
const DEFAULT_SS = {
  enabled: false,
  windows: [
    { startGst: '08:00', endGst: '10:00' },
    { startGst: '13:00', endGst: '15:00' },
    { startGst: '19:00', endGst: '21:00' },
  ],
  days: [0, 1, 2, 3, 4, 5, 6],
  todayTimes: [],
  generatedDate: '',
};

app.get('/api/clients/:id/smart-schedule', requireLicense, (req, res) => {
  const cfgPath = path.join(CLIENTS_DIR, req.params.id, 'config.json');
  if (!fs.existsSync(cfgPath)) return res.status(404).json({ error: 'Client not found' });
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const ss  = { ...DEFAULT_SS, ...(cfg.smartSchedule || {}) };
  res.json({ ...ss, todayTimesGst: (ss.todayTimes || []).map(utcHhmmToGstHhmm) });
});

app.patch('/api/clients/:id/smart-schedule', requireLicense, (req, res) => {
  const cfgPath = path.join(CLIENTS_DIR, req.params.id, 'config.json');
  if (!fs.existsSync(cfgPath)) return res.status(404).json({ error: 'Client not found' });
  let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.smartSchedule = { ...DEFAULT_SS, ...(cfg.smartSchedule || {}), ...req.body };
  const times = generateSmartScheduleTimes(cfg.smartSchedule.windows || []);
  const todayUTC = new Date().toISOString().slice(0, 10);
  cfg.smartSchedule.todayTimes    = times;
  cfg.smartSchedule.generatedDate = todayUTC;
  if (cfg.smartSchedule.enabled) {
    cfg.schedule = cfg.schedule || {};
    cfg.schedule.leadgen = times;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  res.json({ success: true, ...cfg.smartSchedule, todayTimesGst: times.map(utcHhmmToGstHhmm) });
});

// ─── Daily report: manual trigger / test ─────────────────────────────────────
app.post('/api/daily-report/send-now', requireLicense, async (req, res) => {
  try {
    await sendDailyReport();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-client send-now (from client Settings tab)
app.post('/api/clients/:id/daily-report/send-now', requireLicense, async (req, res) => {
  try {
    await sendDailyReport(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/clients/:id/runs/:runId', requireLicense, (req, res) => {
  const { id, runId } = req.params;
  // Validate runId is safe (hex chars only)
  if (!/^[0-9a-f]{8}$/.test(runId)) return res.status(400).json({ error: 'Invalid runId' });
  const logFile = path.join(CLIENTS_DIR, id, 'logs', 'runs', `${runId}.log`);
  if (!fs.existsSync(logFile)) return res.status(404).json({ error: 'Log not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(fs.readFileSync(logFile, 'utf8'));
});

// ─── Live run status — returns active run(s) for a client with recent output ───
app.get('/api/clients/:id/run/active', requireLicense, (req, res) => {
  const clientId = req.params.id;
  const active = [];
  for (const [runId, entry] of runningProcesses) {
    if (entry.clientId === clientId) {
      const elapsed = Math.round((Date.now() - new Date(entry.startedAt).getTime()) / 1000);
      active.push({
        runId,
        command: entry.command,
        startedAt: entry.startedAt,
        elapsedSeconds: elapsed,
        lastActivity: entry.lastActivity || 'Starting…',
        lastActivityAt: entry.lastActivityAt || null,
        recentLines: (entry.recentLines || []).slice(-15),
      });
    }
  }
  res.json(active);
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

// ─── Proxy test ──────────────────────────────────────────────────────────────
app.get('/api/clients/:id/proxy-test', requireLicense, async (req, res) => {
  const cDir = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  const cc = JSON.parse(fs.readFileSync(path.join(cDir, 'config.json'), 'utf8'));
  const proxyUrl = cc.proxy?.url;
  if (!proxyUrl) return res.json({ proxy: null, message: 'No proxy configured' });

  const results = { proxy: proxyUrl.replace(/:([^:@]+)@/, ':***@'), expectedGeo: cc.proxy?.geo || 'any' };

  // Test 1: direct curl through proxy to ipinfo.io
  try {
    const out = execSync(
      `curl -s --max-time 15 --proxy ${JSON.stringify(proxyUrl)} https://ipinfo.io/json`,
      { encoding: 'utf8', timeout: 20000 }
    );
    results.ipinfo = JSON.parse(out);
    results.actualCountry = results.ipinfo.country;
    results.geoMatch = !cc.proxy?.geo || results.ipinfo.country === cc.proxy.geo;
  } catch (e) {
    results.ipinfo = null;
    results.curlError = (e.stderr || e.message || '').substring(0, 500);
    results.geoMatch = false;
  }

  // Test 2: test via Playwright (same way automation does it)
  try {
    const script = `
const { chromium } = require('playwright');
(async () => {
  const u = new URL(${JSON.stringify(proxyUrl.includes('://') ? proxyUrl : 'http://' + proxyUrl)});
  const opts = {
    headless: false,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
    proxy: { server: u.protocol + '//' + u.host }
  };
  if (u.username) opts.proxy.username = decodeURIComponent(u.username);
  if (u.password) opts.proxy.password = decodeURIComponent(u.password);
  let ctx;
  try {
    ctx = await chromium.launch(opts);
    const page = await ctx.newPage();
    await page.goto('https://ipinfo.io/json', { timeout: 20000 });
    const text = await page.textContent('body');
    console.log(text);
  } finally { if (ctx) await ctx.close(); }
})();`;
    const tmpFile = `/tmp/proxy-test-${Date.now()}.js`;
    fs.writeFileSync(tmpFile, script);
    const out = execSync(`node ${tmpFile}`, { encoding: 'utf8', timeout: 30000, env: { ...process.env, DISPLAY: ':99', NODE_PATH: process.env.NODE_PATH || '/app/node_modules' } });
    try { results.playwrightIpinfo = JSON.parse(out.trim()); } catch { results.playwrightRaw = out.trim().substring(0, 300); }
    fs.unlinkSync(tmpFile);
  } catch (e) {
    results.playwrightError = (e.stderr || e.message || '').substring(0, 500);
  }

  res.json(results);
});

// ─── Clear leads (wipe fake/test data) ──────────────────────────────────────
app.delete('/api/clients/:id/leadgen/leads', requireLicense, (req, res) => {
  const lgDir = path.join(CLIENTS_DIR, req.params.id, 'leadgen');
  const leadsPath = path.join(lgDir, 'leads.json');
  const logPath = path.join(lgDir, 'outreach-log.ndjson');
  let cleared = [];
  if (fs.existsSync(leadsPath)) { fs.writeFileSync(leadsPath, '[]'); cleared.push('leads.json'); }
  if (fs.existsSync(logPath)) { fs.writeFileSync(logPath, ''); cleared.push('outreach-log.ndjson'); }
  res.json({ success: true, cleared });
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

  const { action, stage, notes, feedback, purchase_amount, tags } = req.body;
  try {
    if (action === 'convert') {
      lgDb.markConverted(cDir, leadId);
    } else if (action === 'dnd') {
      lgDb.markDoNotEngage(cDir, leadId);
    } else if (feedback !== undefined) {
      // feedback: 'good' | 'bad' | 'purchased' | 'clear'
      const fields = {};
      if (feedback === 'good')      { fields.feedback_good = 1; fields.feedback_bad = 0; }
      else if (feedback === 'bad')  { fields.feedback_bad  = 1; fields.feedback_good = 0; }
      else if (feedback === 'purchased') {
        fields.feedback_purchased = 1;
        if (purchase_amount !== undefined) fields.purchase_amount = purchase_amount;
      } else if (feedback === 'clear_purchased') {
        fields.feedback_purchased = 0; fields.purchase_amount = null;
      } else if (feedback === 'clear') {
        fields.feedback_good = 0; fields.feedback_bad = 0; fields.feedback_purchased = 0; fields.purchase_amount = null;
      }
      if (tags !== undefined) fields.feedback_tags = tags; // array of strings
      lgDb.patchLead(cDir, leadId, fields);
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

// GET /api/clients/:id/leadgen/competitor-view?handle=X
// Returns intel findings + pipeline funnel + lead list + active DMs for one competitor source
app.get('/api/clients/:id/leadgen/competitor-view', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: 'handle param required' });

  // Load saved competitor intel from knowledge base
  const knowledgePath = path.join(cDir, 'knowledge', 'competitors.json');
  const allComps = fs.existsSync(knowledgePath) ? JSON.parse(fs.readFileSync(knowledgePath, 'utf8')) : [];
  const h = handle.replace(/^@/, '').toLowerCase();
  const intel = allComps.find(c =>
    (c.name || '').toLowerCase() === h ||
    (c.instagram || '').replace(/^@/, '').toLowerCase() === h ||
    (c.tiktok    || '').replace(/^@/, '').toLowerCase() === h ||
    (c.x         || '').replace(/^@/, '').toLowerCase() === h
  ) || null;

  // Lead pipeline data from leadgen db
  const view = lgDb.getCompetitorView(cDir, handle);

  // Per-lead outreach log (last 30 actions for active DM leads)
  const leadLogs = {};
  for (const lead of view.activeDMs) {
    leadLogs[lead.username] = lgDb.getLog(cDir, { username: lead.username, limit: 10 });
  }

  res.json({ intel, ...view, leadLogs });
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

  // Followers: prefer NDJSON (large-scale) — return first 200 rows for preview
  if (section === 'followers') {
    const kDir = knowledgeDir(id);
    const ndjsonFile = path.join(kDir, 'followers.ndjson');
    if (fs.existsSync(ndjsonFile)) {
      const preview = [];
      const rl = readline.createInterface({ input: fs.createReadStream(ndjsonFile), crlfDelay: Infinity });
      rl.on('line', line => {
        if (preview.length >= 200) { rl.close(); return; }
        if (!line.trim()) return;
        try { preview.push(JSON.parse(line)); } catch {}
      });
      rl.on('close', () => res.json(preview));
      return;
    }
  }

  const f = path.join(knowledgeDir(id), `${section}.json`);
  if (!fs.existsSync(f)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { res.json([]); }
});

app.put('/api/clients/:id/knowledge/:section', requireLicense, (req, res) => {
  const { id, section } = req.params;
  if (!KNOWLEDGE_SECTIONS.has(section)) return res.status(400).json({ error: 'Invalid section' });
  if (!fs.existsSync(path.join(CLIENTS_DIR, id))) return res.status(404).json({ error: 'Client not found' });
  const data = Array.isArray(req.body) ? req.body : [];
  const kDir = knowledgeDir(id);
  fs.writeFileSync(path.join(kDir, `${section}.json`), JSON.stringify(data, null, 2));
  // If clearing followers, also remove NDJSON file
  if (section === 'followers' && data.length === 0) {
    try { fs.unlinkSync(path.join(kDir, 'followers.ndjson')); } catch {}
    try { fs.unlinkSync(path.join(kDir, 'followers-overlap.json')); } catch {}
  }
  res.json({ success: true, count: data.length });
});

app.post('/api/clients/:id/knowledge/products/import', requireLicense, (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'products array required' });

  const kDir = path.join(CLIENTS_DIR, req.params.id, 'knowledge');
  fs.mkdirSync(kDir, { recursive: true });
  const filePath = path.join(kDir, 'products.json');

  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}

  let imported = 0, updated = 0;
  for (const p of products) {
    if (!p.name) continue;
    const idx = existing.findIndex(e =>
      (e.url && p.url && e.url === p.url) ||
      e.name.toLowerCase() === p.name.toLowerCase()
    );
    if (idx >= 0) { existing[idx] = { ...existing[idx], ...p }; updated++; }
    else { existing.push(p); imported++; }
  }

  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));

  // Kick off background image download (don't await — return response immediately)
  downloadProductImages(req.params.id).catch(e => console.error('[assets] auto-pull error:', e.message));

  res.json({ imported, updated, total: existing.length });
});

// GET /api/clients/:id/assets/pull-status — check image download progress
app.get('/api/clients/:id/assets/pull-status', requireLicense, (req, res) => {
  const statusPath = path.join(CLIENTS_DIR, req.params.id, 'assets', 'pull-status.json');
  try {
    res.json(JSON.parse(fs.readFileSync(statusPath, 'utf8')));
  } catch {
    res.json({ running: false, total: 0, done: 0, failed: 0 });
  }
});

// POST /api/clients/:id/assets/pull-images — trigger background image download
app.post('/api/clients/:id/assets/pull-images', requireLicense, (req, res) => {
  const statusPath = path.join(CLIENTS_DIR, req.params.id, 'assets', 'pull-status.json');
  // Check if already running
  try {
    const s = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (s.running) return res.json({ message: 'Already running', status: s });
  } catch {}
  // Start download in background (don't await)
  downloadProductImages(req.params.id).catch(e => console.error('[assets] pull error:', e.message));
  res.json({ message: 'Image pull started' });
});

// ─── AI Intel research run (SSE streaming) ───────────────────────────────────
// ─── Intel background job store ────────────────────────────────────────────────
// Jobs survive browser disconnects — safe to navigate away.
// intelJobs: runId → { runId, clientId, command, label, status, startedAt,
//   finishedAt, lines[], accOutput, extracted, extractedSection, extractedCount,
//   code, signal, listeners: Set<res> }
const intelJobs = new Map();

function intelJobBroadcast(job, type, data) {
  const line = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  job.lines.push(line);
  for (const r of job.listeners) { try { r.write(line); } catch {} }
}

function intelJobFinish(job) {
  if (job._timeoutTimer) { clearTimeout(job._timeoutTimer); job._timeoutTimer = null; }
  if (job._heartbeatTimer) { clearInterval(job._heartbeatTimer); job._heartbeatTimer = null; }
  for (const r of job.listeners) { try { r.end(); } catch {} }
  job.listeners.clear();
  job.finishedAt = new Date().toISOString();
  // Persist hunt runs to a log file so history survives restarts
  if (job.command === 'competitor-hunt') {
    try {
      const huntLogPath = path.join(CLIENTS_DIR, job.clientId, 'leadgen', 'hunt-history.json');
      let history = [];
      try { history = JSON.parse(fs.readFileSync(huntLogPath, 'utf8')); } catch {}
      history.unshift({
        runId: job.runId,
        competitorName: job.meta?.competitorName || null,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        leadsTotal: job.extractedCount || 0,
      });
      if (history.length > 50) history = history.slice(0, 50); // keep last 50
      fs.writeFileSync(huntLogPath, JSON.stringify(history, null, 2));
    } catch (e) { console.error('[intel] hunt-history write error:', e.message); }
  }
  // Keep only 10 jobs per client to avoid unbounded memory
  const clientJobs = [...intelJobs.values()].filter(j => j.clientId === job.clientId);
  if (clientJobs.length > 10) {
    const oldest = clientJobs.sort((a,b) => (a.startedAt||'').localeCompare(b.startedAt||''))[0];
    if (oldest.status !== 'running') intelJobs.delete(oldest.runId);
  }
}

const INTEL_COMMANDS = new Set(['products-scrape','competitor-research','sources-discover','keywords-research','competitor-hunt']);
const INTEL_LABELS = {
  'products-scrape':    'Products Scrape',
  'competitor-research':'Competitor Research',
  'sources-discover':   'Hot Sources Discovery',
  'keywords-research':  'Keywords Research',
  'competitor-hunt':    'Audience Hunt',
};

// POST /api/clients/:id/intel/run  — start a background research job, returns JSON {runId}
// Client polls /tail and /intel/jobs every 5s — no SSE (Railway drops SSE connections instantly)
// Uses OpenAI direct API for supported commands (cheaper, faster, no browser needed)
// Falls back to Claude CLI for commands that need browser automation (competitor-hunt)
app.post('/api/clients/:id/intel/run', requireLicense, (req, res) => {
  const { command, params = {} } = req.body;
  if (!INTEL_COMMANDS.has(command)) return res.status(400).json({ error: `Unknown intel command: ${command}` });

  const clientDirPath = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(clientDirPath)) return res.status(404).json({ error: 'Client not found' });

  const config = loadConfig();

  // Route to OpenAI for supported commands when key is available
  const useOpenAI = config.openaiApiKey && OPENAI_INTEL_COMMANDS.has(command);

  if (!useOpenAI && !config.anthropicApiKey) {
    return res.status(400).json({ error: 'API key required for AI research (configure OpenAI or Anthropic key)' });
  }

  if (useOpenAI) {
    // OpenAI direct path — no browser, server-side fetch + API call
    const job = {
      runId: null, clientId: req.params.id, command,
      label: INTEL_LABELS[command] || command,
      meta: { competitorName: params.name || null },
      status: 'running',
      startedAt: new Date().toISOString(), finishedAt: null,
      lines: [], accOutput: '',
      extracted: false, extractedSection: null, extractedCount: 0,
      code: null, signal: null,
      listeners: new Set(),
    };
    const runId = crypto.randomBytes(4).toString('hex');
    job.runId = runId;
    intelJobs.set(runId, job);

    // Persist job start
    try {
      fs.mkdirSync(path.join(clientDirPath, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(clientDirPath, 'logs', 'last-intel-run.json'), JSON.stringify({
        runId, command, label: job.label,
        status: 'running', startedAt: job.startedAt, finishedAt: null,
        extracted: false, extractedSection: null, extractedCount: 0,
      }));
    } catch {}

    // Run async — don't block the response
    runOpenAIIntel(
      req.params.id, command, params,
      (type, text) => {
        if (type === 'output') job.accOutput += text;
        intelJobBroadcast(job, type, { text });
      },
      (closedRunId, code, signal, startedAt, status) => {
        const parsed = parseIntelData(job.accOutput);
        let extracted = false, extractedSection = null, extractedCount = 0;
        if (parsed) {
          extracted = true;
          extractedSection = parsed.section;
          extractedCount = Array.isArray(parsed.data) ? parsed.data.length : 1;
        }
        job.status = extracted ? 'done' : (status === 'completed' ? 'done' : 'failed');
        job.code = code;
        job.extracted = extracted; job.extractedSection = extractedSection; job.extractedCount = extractedCount;
        job.finishedAt = new Date().toISOString();
        intelJobBroadcast(job, 'done', { code, runId, status: job.status, extracted, extractedSection, extractedCount });
        try {
          fs.writeFileSync(path.join(clientDirPath, 'logs', 'last-intel-run.json'), JSON.stringify({
            runId, command, label: job.label,
            status: job.status === 'done' ? 'completed' : 'failed',
            startedAt: job.startedAt, finishedAt: job.finishedAt,
            extracted, extractedSection, extractedCount,
          }));
        } catch {}
        intelJobFinish(job);
      }
    ).catch(err => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      intelJobBroadcast(job, 'output', { text: `\n❌ Error: ${err.message}\n` });
      intelJobBroadcast(job, 'done', { code: 1, runId, status: 'failed', extracted: false });
      intelJobFinish(job);
    });

    return res.json({ runId, startedAt: job.startedAt, provider: 'openai' });
  }

  // Claude CLI path (for competitor-hunt and fallback)
  const clientConfig = JSON.parse(fs.readFileSync(path.join(clientDirPath, 'config.json'), 'utf8'));
  const intelPrompt = buildIntelPrompt(command, params, clientConfig, req.params.id);

  // Register job object first so the onData callback can reference it
  const job = {
    runId: null, clientId: req.params.id, command,
    label: command === 'competitor-hunt'
      ? `🎯 Hunt: ${params.name || 'competitor'}`
      : (INTEL_LABELS[command] || command),
    meta: { competitorName: params.name || null },
    status: 'running',
    startedAt: null, finishedAt: null,
    lines: [], accOutput: '',
    extracted: false, extractedSection: null, extractedCount: 0,
    code: null, signal: null,
    listeners: new Set(),
  };

  let runResult;
  try {
    runResult = spawnRun(
      req.params.id,
      command,
      (type, text) => {
        if (type === 'output') job.accOutput += text;
        intelJobBroadcast(job, type, { text });
      },
      (runId, code, signal, startedAt, status) => {
        let extracted = false, extractedSection = null, extractedCount = 0;
        if (command === 'competitor-hunt') {
          if (status === 'completed' || code === 0) {
            try {
              const lgDb = require('./leadgen/db');
              const cDir = path.join(CLIENTS_DIR, req.params.id);
              const leads = lgDb.getLeads(cDir, {});
              extractedCount = leads.length;
              extracted = true;
              extractedSection = 'leads';
            } catch {}
          }
        } else if (status === 'completed' || code === 0) {
          const parsed = parseIntelData(job.accOutput);
          if (parsed) {
            try {
              applyIntelData(req.params.id, parsed);
              extracted = true;
              extractedSection = parsed.section;
              extractedCount = Array.isArray(parsed.data) ? parsed.data.length : 1;
              console.log(`[intel] Extracted ${extractedCount} items into ${extractedSection} for ${req.params.id}`);
            } catch (e) { console.error('[intel] applyIntelData error:', e.message); }
          }
        }
        job.status = (signal && signal !== 'SIGTERM') ? 'failed' : (extracted || code === 0) ? 'done' : 'failed';
        job.code = code; job.signal = signal;
        job.extracted = extracted; job.extractedSection = extractedSection; job.extractedCount = extractedCount;
        if (signal) intelJobBroadcast(job, 'output', { text: `\n[Process ${signal}]\n` });
        intelJobBroadcast(job, 'done', { code, runId, status, extracted, extractedSection, extractedCount });
        // Update persisted state file
        try {
          const sf = path.join(CLIENTS_DIR, req.params.id, 'logs', 'last-intel-run.json');
          fs.writeFileSync(sf, JSON.stringify({
            runId, command, label: job.label,
            status: extracted ? 'completed' : (signal ? 'failed' : (code === 0 ? 'completed' : 'failed')),
            startedAt: job.startedAt, finishedAt: new Date().toISOString(),
            extracted, extractedSection, extractedCount,
          }));
        } catch {}
        intelJobFinish(job);
      },
      intelPrompt
    );
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Finalize job registration
  job.runId = runResult.runId;
  job.startedAt = runResult.startedAt;
  intelJobs.set(runResult.runId, job);

  // Persist job start to disk — survives server restarts
  try {
    fs.mkdirSync(path.join(clientDirPath, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(clientDirPath, 'logs', 'last-intel-run.json'), JSON.stringify({
      runId: job.runId, command, label: job.label,
      status: 'running', startedAt: job.startedAt, finishedAt: null,
      extracted: false, extractedSection: null, extractedCount: 0,
    }));
  } catch {}

  // Hard timeout
  const INTEL_TIMEOUT_MS = command === 'competitor-hunt' ? 30 * 60 * 1000 : 10 * 60 * 1000;
  const timeoutLabel = command === 'competitor-hunt' ? '30 minutes' : '10 minutes';
  const intelTimeoutTimer = setTimeout(() => {
    if (job.status !== 'running') return;
    const entry = runningProcesses.get(job.runId);
    if (entry && entry.proc) entry.proc.kill('SIGTERM');
    runningProcesses.delete(job.runId);
    job.status = 'failed';
    intelJobBroadcast(job, 'output', { text: `\n[Timed out after ${timeoutLabel}]\n` });
    intelJobBroadcast(job, 'done', { code: null, status: 'failed', extracted: false });
    intelJobFinish(job);
  }, INTEL_TIMEOUT_MS);
  job._timeoutTimer = intelTimeoutTimer;

  // Heartbeat every 30s — written to job.lines so polling clients see activity
  const _hbStart = Date.parse(job.startedAt);
  const _heartbeatTimer = setInterval(() => {
    if (job.status !== 'running') { clearInterval(_heartbeatTimer); return; }
    const elapsed = Math.round((Date.now() - _hbStart) / 1000);
    const mins = Math.floor(elapsed / 60), secs = elapsed % 60;
    intelJobBroadcast(job, 'progress', { text: `⏳ Still running… (${mins}m ${secs}s elapsed)\n` });
  }, 30000);
  job._heartbeatTimer = _heartbeatTimer;

  // Return runId as JSON — client will poll /tail and /intel/jobs
  res.json({ runId: job.runId, startedAt: job.startedAt, label: job.label, command });
});

// GET /api/clients/:id/intel/hunt-history?competitor=X — persistent hunt run history
app.get('/api/clients/:id/intel/hunt-history', requireLicense, (req, res) => {
  const huntLogPath = path.join(CLIENTS_DIR, req.params.id, 'leadgen', 'hunt-history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(huntLogPath, 'utf8')); } catch {}
  const { competitor } = req.query;
  if (competitor) history = history.filter(h => h.competitorName === competitor);
  res.json(history.slice(0, 20));
});

// GET /api/clients/:id/intel/jobs — list recent intel jobs for this client
app.get('/api/clients/:id/intel/jobs', requireLicense, (req, res) => {
  const jobs = [...intelJobs.values()]
    .filter(j => j.clientId === req.params.id)
    .sort((a, b) => (b.startedAt||'').localeCompare(a.startedAt||''))
    .slice(0, 15)
    .map(j => ({
      runId: j.runId, command: j.command, label: j.label, status: j.status,
      startedAt: j.startedAt, finishedAt: j.finishedAt,
      extracted: j.extracted, extractedSection: j.extractedSection, extractedCount: j.extractedCount,
      code: j.code,
    }));
  res.json(jobs);
});

// GET /api/clients/:id/intel/last-run — persisted last-run state (survives restarts)
app.get('/api/clients/:id/intel/last-run', requireLicense, (req, res) => {
  const sf = path.join(CLIENTS_DIR, req.params.id, 'logs', 'last-intel-run.json');
  try { res.json(JSON.parse(fs.readFileSync(sf, 'utf8'))); }
  catch { res.json(null); }
});

// GET /api/clients/:id/intel/jobs/:runId/stream — reconnect SSE: drains buffer then streams live
app.get('/api/clients/:id/intel/jobs/:runId/stream', requireLicense, (req, res) => {
  const job = intelJobs.get(req.params.runId);
  if (!job || job.clientId !== req.params.id) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Drain buffered output first
  for (const line of job.lines) { try { res.write(line); } catch {} }

  if (job.status !== 'running') { res.end(); return; }
  job.listeners.add(res);
  req.on('close', () => { job.listeners.delete(res); });
});

// GET /api/clients/:id/intel/jobs/:runId/tail — return buffered output as JSON for polling
app.get('/api/clients/:id/intel/jobs/:runId/tail', requireLicense, (req, res) => {
  const job = intelJobs.get(req.params.runId);
  if (!job || job.clientId !== req.params.id) return res.status(404).json({ error: 'Job not found' });
  const offset = parseInt(req.query.offset) || 0;
  // Extract plain text from buffered SSE lines
  const texts = [];
  for (const line of job.lines.slice(offset)) {
    try {
      const ev = JSON.parse(line.replace(/^data: /, '').trim());
      if ((ev.type === 'output' || ev.type === 'progress') && ev.text) texts.push(ev.text);
    } catch {}
  }
  res.json({ status: job.status, totalLines: job.lines.length, text: texts.join('') });
});

// DELETE /api/clients/:id/intel/jobs/:runId — cancel a running job
app.delete('/api/clients/:id/intel/jobs/:runId', requireLicense, (req, res) => {
  const job = intelJobs.get(req.params.runId);
  if (!job || job.clientId !== req.params.id) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'running') return res.json({ ok: true, status: job.status });

  const entry = runningProcesses.get(job.runId);
  if (entry && entry.proc) { entry.proc.kill('SIGTERM'); runningProcesses.delete(job.runId); }
  job.status = 'cancelled';
  intelJobBroadcast(job, 'done', { code: null, status: 'cancelled', extracted: false });
  intelJobFinish(job);
  res.json({ ok: true });
});

// ─── Followers: streaming CSV upload → NDJSON ─────────────────────────────────
// Accepts raw CSV body. Parses line-by-line, appends to followers.ndjson.
// Does NOT load entire file into memory.
app.post(
  '/api/clients/:id/knowledge/followers/upload',
  requireLicense,
  express.raw({ limit: '500mb', type: '*/*' }),
  (req, res) => {
    const clientDirPath = path.join(CLIENTS_DIR, req.params.id);
    if (!fs.existsSync(clientDirPath)) return res.status(404).json({ error: 'Client not found' });

    const kDir = knowledgeDir(req.params.id);
    const ndjsonFile = path.join(kDir, 'followers.ndjson');

    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'Empty file' });

    // Parse columns from header
    const parseCSVLine = line => {
      const out = []; let cur = ''; let inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      out.push(cur.trim()); return out;
    };

    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return res.status(400).json({ error: 'File must have header + data rows' });

    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\W+/g, '_'));
    const col = name => headers.findIndex(h => h.includes(name));
    const uCol = col('username') !== -1 ? col('username') : col('handle') !== -1 ? col('handle') : col('user');
    const pCol = col('platform');
    const fCol = col('follower') !== -1 ? col('follower') : col('count');
    const bCol = col('bio') !== -1 ? col('bio') : col('description');
    const sCol = col('source');

    if (uCol === -1) return res.status(400).json({ error: 'CSV must have a username/handle column' });

    let written = 0;
    let skipped = 0;
    const writeStream = fs.createWriteStream(ndjsonFile, { flags: 'a' });

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const c = parseCSVLine(line);
      const username = (c[uCol] || '').trim();
      if (!username) { skipped++; continue; }
      const row = {
        username,
        platform: (c[pCol] || 'instagram').trim(),
        follower_count: parseInt(c[fCol]) || 0,
        bio: (c[bCol] || '').trim(),
        source: (sCol >= 0 ? c[sCol] : '').trim(),
        uploaded_at: new Date().toISOString().slice(0, 10),
      };
      writeStream.write(JSON.stringify(row) + '\n');
      written++;
    }

    writeStream.end(() => {
      // Remove old small-JSON file if it exists (replaced by NDJSON)
      try { fs.unlinkSync(path.join(kDir, 'followers.json')); } catch {}
      res.json({ success: true, written, skipped, total: written });
    });
  }
);

// ─── Followers: streaming stats from NDJSON ───────────────────────────────────
app.get('/api/clients/:id/knowledge/followers/stats', requireLicense, (req, res) => {
  const kDir = knowledgeDir(req.params.id);
  const ndjsonFile = path.join(kDir, 'followers.ndjson');

  if (!fs.existsSync(ndjsonFile)) {
    // Fall back to JSON count
    const jsonFile = path.join(kDir, 'followers.json');
    if (!fs.existsSync(jsonFile)) return res.json({ total: 0, by_platform: {}, hasNdjson: false });
    try {
      const arr = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      const by_platform = {};
      arr.forEach(f => { by_platform[f.platform] = (by_platform[f.platform] || 0) + 1; });
      return res.json({ total: arr.length, by_platform, hasNdjson: false });
    } catch { return res.json({ total: 0, by_platform: {}, hasNdjson: false }); }
  }

  // Stream through NDJSON without loading into memory
  const by_platform = {};
  let total = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonFile), crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line);
      by_platform[r.platform] = (by_platform[r.platform] || 0) + 1;
      total++;
    } catch {}
  });
  rl.on('close', () => res.json({ total, by_platform, hasNdjson: true }));
  rl.on('error', () => res.json({ total, by_platform, hasNdjson: true }));
});

// ─── Followers: overlap scoring ───────────────────────────────────────────────
// Finds users appearing in multiple source lists (= super-targets)
app.post('/api/clients/:id/knowledge/followers/overlap', requireLicense, (req, res) => {
  const kDir = knowledgeDir(req.params.id);
  const ndjsonFile = path.join(kDir, 'followers.ndjson');
  if (!fs.existsSync(ndjsonFile)) return res.status(404).json({ error: 'No NDJSON followers file' });

  // Count how many distinct source accounts each username appears under
  const userSources = {}; // username:platform → Set of sources
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonFile), crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line);
      const key = `${r.username}:${r.platform}`;
      if (!userSources[key]) userSources[key] = new Set();
      if (r.source) userSources[key].add(r.source);
    } catch {}
  });
  rl.on('close', () => {
    const overlap = Object.entries(userSources)
      .map(([key, sources]) => {
        const [username, platform] = key.split(':');
        const count = sources.size;
        return { username, platform, source_count: count,
          sources: [...sources],
          priority: count >= 4 ? 'super-target' : count >= 2 ? 'high-value' : 'known' };
      })
      .filter(u => u.source_count >= 2)
      .sort((a, b) => b.source_count - a.source_count)
      .slice(0, 5000); // cap at 5k

    const overlapFile = path.join(kDir, 'followers-overlap.json');
    fs.writeFileSync(overlapFile, JSON.stringify(overlap, null, 2));
    res.json({ total_overlap: overlap.length,
      super_targets: overlap.filter(u => u.priority === 'super-target').length,
      high_value: overlap.filter(u => u.priority === 'high-value').length });
  });
});

// ─── Intercept config + log ────────────────────────────────────────────────────

const DEFAULT_INTERCEPT_CONFIG = {
  enabled: false,
  competitors_to_watch: [],
  comment_delay_min_minutes: 30,
  comment_delay_max_minutes: 90,
  min_existing_comments: 5,
  max_per_competitor_per_week: 3,
  dm_check_interval_minutes: 15,
  dm_human_review_overlap_threshold: 3,
  comment_strategies: ['mirror_question', 'shared_experience', 'soft_comparison', 'visual_hook'],
  skip_post_types: ['giveaway', 'contest', 'hiring', 'birthday'],
  search_discovery: { brand_search_term: '', ambassador_search_term: '' },
  schedule: [],   // UTC times e.g. ["09:00", "17:00"]
};

function interceptDir(clientId) {
  const d = path.join(CLIENTS_DIR, clientId, 'intercept');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

app.get('/api/clients/:id/intercept/config', requireLicense, (req, res) => {
  const d = interceptDir(req.params.id);
  const f = path.join(d, 'intercept-config.json');
  if (!fs.existsSync(f)) return res.json(DEFAULT_INTERCEPT_CONFIG);
  try { res.json({ ...DEFAULT_INTERCEPT_CONFIG, ...JSON.parse(fs.readFileSync(f, 'utf8')) }); }
  catch { res.json(DEFAULT_INTERCEPT_CONFIG); }
});

app.put('/api/clients/:id/intercept/config', requireLicense, (req, res) => {
  if (!fs.existsSync(path.join(CLIENTS_DIR, req.params.id))) return res.status(404).json({ error: 'Client not found' });
  const d = interceptDir(req.params.id);
  const config = { ...DEFAULT_INTERCEPT_CONFIG, ...req.body };
  fs.writeFileSync(path.join(d, 'intercept-config.json'), JSON.stringify(config, null, 2));
  res.json({ success: true });
});

app.get('/api/clients/:id/intercept/log', requireLicense, (req, res) => {
  const logFile = path.join(interceptDir(req.params.id), 'intercept-log.ndjson');
  if (!fs.existsSync(logFile)) return res.json([]);
  const limit = parseInt(req.query.limit) || 50;
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const entries = lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json(entries);
  } catch { res.json([]); }
});

app.get('/api/clients/:id/intercept/stats', requireLicense, (req, res) => {
  const logFile = path.join(interceptDir(req.params.id), 'intercept-log.ndjson');
  if (!fs.existsSync(logFile)) return res.json({ comments_posted: 0, dms_handled: 0, this_week: 0, by_competitor: {} });
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const entries = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const comments = entries.filter(e => e.action === 'comment_posted');
    const dms = entries.filter(e => e.action === 'dm_replied');
    const thisWeek = comments.filter(e => e.timestamp > weekAgo);
    const by_competitor = {};
    thisWeek.forEach(e => { by_competitor[e.competitor_account] = (by_competitor[e.competitor_account] || 0) + 1; });
    res.json({ comments_posted: comments.length, dms_handled: dms.length, this_week: thisWeek.length, by_competitor });
  } catch { res.json({ comments_posted: 0, dms_handled: 0, this_week: 0, by_competitor: {} }); }
});

// ─── Hunt Settings API ────────────────────────────────────────────────────────

app.get('/api/clients/:id/hunt-settings', requireLicense, (req, res) => {
  if (!fs.existsSync(path.join(CLIENTS_DIR, req.params.id))) return res.status(404).json({ error: 'Client not found' });
  res.json(getHuntSettings(req.params.id));
});

app.put('/api/clients/:id/hunt-settings', requireLicense, (req, res) => {
  const cDir = path.join(CLIENTS_DIR, req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  const f = path.join(cDir, 'leadgen', 'hunt-settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

app.get('/api/clients/:id/hunt-settings/budget', requireLicense, (req, res) => {
  if (!fs.existsSync(path.join(CLIENTS_DIR, req.params.id))) return res.status(404).json({ error: 'Client not found' });
  const budget = getHuntBudget(req.params.id);
  const hs = getHuntSettings(req.params.id);
  res.json({ budget, limits: hs.safety.daily_limits });
});

app.post('/api/clients/:id/hunt-settings/budget/reset', requireLicense, (req, res) => {
  if (!fs.existsSync(path.join(CLIENTS_DIR, req.params.id))) return res.status(404).json({ error: 'Client not found' });
  const todayUTC = new Date().toISOString().slice(0, 10);
  const reset = {
    date: todayUTC,
    accounts: {
      instagram: { follows: 0, likes: 0, comments: 0, dms: 0 },
      tiktok:    { follows: 0, likes: 0, comments: 0, dms: 0 },
    },
  };
  saveHuntBudget(req.params.id, reset);
  res.json({ success: true, budget: reset });
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

// ─── Brand Voice MD helper ───
function writeBrandVoiceMd(cDir, name, bv, vi = {}) {
  fs.mkdirSync(path.join(cDir, 'config'), { recursive: true });
  const viSection = `
## Visual Identity

### Lifestyle Imagery Rules
${vi.lifestyleRules || `- **People in bed / bedroom scenes**: Always show an Emirati woman wearing a hair towel and bathrobe — never western-only imagery
- **Appearance**: UAE-appropriate — Arab or South Asian, modest, naturally beautiful, no heavy makeup
- **Setting**: Modern UAE apartment or villa — marble surfaces, neutral linen tones, warm natural light, morning atmosphere
- **Mood**: Calm luxury, morning routine, aspirational but attainable`}

### Per-Format Specs
${vi.formatSpecs || `- **Carousel (3–5 slides)**: Slide 1 = lifestyle hook (person/emotion), Slides 2–3 = feature callouts with bilingual text, Slide 4 = social proof / lead quote, Slide 5 = CTA
- **Single Post**: Product-led with subtle lifestyle element in background
- **Reel / Story (9:16 vertical)**: Bold full-bleed lifestyle image, animated text overlay, CTA sticker at bottom
- **Story**: Light airy aesthetic, quick benefit highlight, swipe-up or DM CTA sticker`}

### Text Overlay Rules
${vi.textOverlay || `- **Bilingual required**: English (top, larger) + Arabic (below, RTL, equal visual weight)
- Font: Clean modern sans-serif — absolutely no decorative or script fonts
- Color: High contrast — dark text on light background preferred
- Size: Large and readable on mobile screens (min 18% of image height per language)
- Total text area: <20% of image (Meta / Instagram compliance)
- Arabic text must be proper RTL — do not mirror or reverse English`}

### Brand Colours
${vi.brandColours || `- Primary: Deep forest green or bamboo-tone warm neutral
- Accent: Soft gold or warm white
- Avoid: Heavy blacks, neon colours, overly saturated palettes`}

### What to NEVER Generate
${vi.neverGenerate || `- Western woman in the main lifestyle role (background OK)
- Overly sexual or revealing imagery
- Competitor product logos or packaging
- Fake reviews or misleading before/after imagery`}
`;

  const md = `# Brand Voice: ${name}

## Personality
${bv.personality || 'Warm, knowledgeable, and aspirational — like a trusted lifestyle curator'}

## Tone
${bv.tone || 'Conversational, never corporate. Friendly but professional. Avoids hollow buzzwords.'}

## Emoji
Max per post/reply: ${bv.emojiMax || 2}

## Languages
${(bv.languages || ['English', 'Arabic']).join(', ')}

## Never Say
${(bv.neverSay || ['cheap', 'just', 'literally', 'amazing deal']).map(s => `- ${s}`).join('\n')}

## Always Do
${(bv.alwaysDo || ['reply in the same language as the commenter', 'empathise before promoting', 'keep CTAs soft and curiosity-driven']).map(s => `- ${s}`).join('\n')}
${viSection}`;

  fs.writeFileSync(path.join(cDir, 'config', 'brand-voice.md'), md);
}

// ─── Precision Content Engine ─────────────────────────────────────────────────

function precisionBriefsPath(cDir) {
  return path.join(cDir, 'leadgen', 'precision-briefs.json');
}

function loadPrecisionBriefs(cDir) {
  const p = precisionBriefsPath(cDir);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function savePrecisionBriefs(cDir, briefs) {
  const p = precisionBriefsPath(cDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(briefs, null, 2));
  fs.renameSync(tmp, p);
}

// Atomic patch for a single brief — re-reads file immediately before writing
// to avoid race conditions when multiple images generate concurrently
function patchPrecisionBrief(cDir, briefId, fields) {
  const briefs = loadPrecisionBriefs(cDir);
  const idx = briefs.findIndex(b => b.brief_id === briefId);
  if (idx === -1) return null;
  briefs[idx] = { ...briefs[idx], ...fields };
  savePrecisionBriefs(cDir, briefs);
  return briefs[idx];
}

// GET /api/clients/:id/precision/briefs
app.get('/api/clients/:id/precision/briefs', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  res.json(loadPrecisionBriefs(cDir));
});

// PATCH /api/clients/:id/precision/briefs/:briefId — approve/reject/edit
app.patch('/api/clients/:id/precision/briefs/:briefId', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  const briefs = loadPrecisionBriefs(cDir);
  const idx = briefs.findIndex(b => b.brief_id === req.params.briefId);
  if (idx === -1) return res.status(404).json({ error: 'Brief not found' });
  briefs[idx] = { ...briefs[idx], ...req.body, updated_at: new Date().toISOString() };
  savePrecisionBriefs(cDir, briefs);
  res.json({ ok: true, brief: briefs[idx] });
});

// DELETE /api/clients/:id/precision/briefs/:briefId
app.delete('/api/clients/:id/precision/briefs/:briefId', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });
  const briefs = loadPrecisionBriefs(cDir).filter(b => b.brief_id !== req.params.briefId);
  savePrecisionBriefs(cDir, briefs);
  res.json({ ok: true });
});

// POST /api/clients/:id/precision/generate-brief — cluster leads + create briefs via Anthropic
app.post('/api/clients/:id/precision/generate-brief', requireLicense, async (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const config = loadConfig();
  if (!config.anthropicApiKey) return res.status(400).json({ error: 'Anthropic API key not configured' });

  let clientConfig = {};
  try { clientConfig = JSON.parse(fs.readFileSync(path.join(cDir, 'config.json'), 'utf8')); } catch {}

  // Load brand voice for visual identity
  let brandVoiceMd = '';
  try { brandVoiceMd = fs.readFileSync(path.join(cDir, 'config', 'brand-voice.md'), 'utf8'); } catch {}

  // Read all leads
  const leads = lgDb.getLeads(cDir, { limit: 200 }).filter(l => !l.is_converted && !l.is_do_not_engage);
  if (leads.length < 2) return res.status(400).json({ error: 'Need at least 2 leads to generate briefs' });

  // Load product catalogue for reference image selection
  let products = [];
  try { products = JSON.parse(fs.readFileSync(path.join(cDir, 'knowledge', 'products.json'), 'utf8')); } catch {}
  const productCatalogue = products.map((p, i) => {
    const firstImg = (p.images || []).find(img => img.local_url || img.url);
    return {
      index: i,
      name: p.name,
      price: p.price || '',
      description: (p.description || '').slice(0, 120),
      image_url: firstImg ? (firstImg.local_url || firstImg.url) : null,
      tags: (p.tags || []).slice(0, 5),
      usps: (p.usps || p.pain_points || []).slice(0, 3),
    };
  }).filter(p => p.image_url); // only include products that have images

  const leadsSummary = leads.map(l => ({
    id: l.id, platform: l.platform, username: l.username,
    bio: (l.bio_snippet || '').slice(0, 120),
    score: l.total_score, stage: l.engagement_stage,
    source_type: l.source_type, notes: (l.notes || '').slice(0, 120),
    feedback_good: l.feedback_good || 0, feedback_purchased: l.feedback_purchased || 0,
  }));

  // Extract visual identity from brand voice md
  const viMatch = brandVoiceMd.match(/## Visual Identity([\s\S]*?)(?=^##|\Z)/m);
  const visualIdentityContext = viMatch ? viMatch[0].trim() : 'UAE Emirati lifestyle imagery, bilingual English+Arabic';

  const systemPrompt = `You are a precision content strategist for "${clientConfig.name || 'the brand'}".
Product: ${clientConfig.product_name || clientConfig.name || 'Bamboo bedding'}
Niche: ${clientConfig.niche || 'luxury bedding UAE'}
Target market: ${clientConfig.target_geo || 'UAE'}

Visual identity for all image generation:
${visualIdentityContext}

You analyse lead pipelines and generate data-driven content briefs where every post has guaranteed pre-qualified viewers ready to engage.`;

  const productCatalogueText = productCatalogue.length
    ? `\nPRODUCT CATALOGUE (${productCatalogue.length} products with images available as reference):\n${productCatalogue.map(p => `[${p.index}] "${p.name}" — ${p.price} — ${p.description} | USPs: ${p.usps.join(', ')}`).join('\n')}\n`
    : '';

  const userPrompt = `Here are ${leads.length} leads in our pipeline:

${JSON.stringify(leadsSummary, null, 2)}
${productCatalogueText}
TASK:
1. Cluster these leads into groups by shared pain point (e.g. cooling, back support, luxury gifting, hotel procurement, interior design styling, etc.). Minimum 2 leads per cluster.

2. For each cluster, generate one content brief following these scale rules:
   - 1–2 leads → "dm_only" strategy (no post, just DMs)
   - 3–5 leads → format: "carousel"
   - 6–10 leads → format: "reel"
   - 10+ leads → format: "reel" AND create a second "carousel" brief for the same cluster

3. For each brief, write a concise image prompt following the brand visual identity (Emirati woman, hair towel, bathrobe, UAE apartment setting).

4. If a product from the catalogue is relevant to the brief's pain point, set "product_image_index" to that product's index number. This will attach the real product photo to the Gemini image generation so the output features the actual product. Only set this when a specific product clearly matches — leave null if no product fits.

IMPORTANT: Return a JSON array ONLY. No markdown, no code fences, no extra text.
Keep ALL string values SHORT (under 200 chars each). No bilingual text in JSON strings — English only to avoid encoding issues. Keep captions under 150 chars.

Each brief object uses ONLY these fields:
{
  "brief_id": "brief_XXXXXX",
  "cluster_topic": "Hot Sleepers UAE",
  "pain_point": "overheating at night",
  "leads": [{"id": 1, "username": "@handle"}],
  "format": "carousel",
  "key_message": "one sentence",
  "caption": "English caption under 150 chars with 2-3 hashtags",
  "image_prompt": "scene description under 200 chars. Emirati woman in white bathrobe and hair towel, UAE apartment, bamboo bedding, soft morning light.",
  "product_image_index": null,
  "tagging_notes": "Who to tag and why, plain text",
  "dm_template": "Short warm DM opening, no pitch, under 100 chars"
}`;

  try {
    const model = 'claude-sonnet-4-6'; // use Sonnet for complex clustering with many leads
    const body = JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const apiRes = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      };
      let data = '';
      const req2 = https.request(opts, r => {
        r.on('data', c => { data += c; });
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON from Anthropic')); } });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (apiRes.error) return res.status(500).json({ error: `Anthropic: ${apiRes.error.message || JSON.stringify(apiRes.error)}` });
    const text = apiRes.content?.[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error: `Claude returned no JSON. Stop reason: ${apiRes.stop_reason}. Preview: ${text.slice(0, 300)}` });

    // Try to parse; if it fails, attempt to extract individual objects as fallback
    let parsedBriefs;
    try {
      parsedBriefs = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      // Extract individual {...} objects that are valid JSON
      const objMatches = jsonMatch[0].match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g) || [];
      parsedBriefs = [];
      for (const obj of objMatches) {
        try { parsedBriefs.push(JSON.parse(obj)); } catch {}
      }
      if (!parsedBriefs.length) {
        return res.status(500).json({ error: `JSON parse failed: ${parseErr.message}. Raw (first 400 chars): ${jsonMatch[0].slice(0, 400)}` });
      }
    }

    const newBriefs = parsedBriefs.map(b => {
      // Resolve product_image_index → product_image_url + product_name
      let product_image_url = null, product_name = null;
      if (b.product_image_index != null && productCatalogue[b.product_image_index]) {
        const prod = productCatalogue[b.product_image_index];
        product_image_url = prod.image_url;
        product_name = prod.name;
      }
      return {
        ...b,
        brief_id: b.brief_id || 'brief_' + Math.random().toString(16).slice(2, 8),
        status: 'pending',
        created_at: new Date().toISOString(),
        product_image_url,
        product_name,
        generated_images: [],
        posted_url: null, posted_at: null, amplification_done: false,
      };
    });

    // Merge with existing (keep approved/posted, replace pending)
    const existing = loadPrecisionBriefs(cDir).filter(b => b.status !== 'pending');
    savePrecisionBriefs(cDir, [...existing, ...newBriefs]);

    res.json({ ok: true, count: newBriefs.length, briefs: newBriefs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clients/:id/precision/generate-image/:briefId — Gemini image via @google/genai SDK
app.post('/api/clients/:id/precision/generate-image/:briefId', requireLicense, async (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const config = loadConfig();
  if (!config.geminiApiKey) return res.status(400).json({ error: 'Gemini API key not configured — add it in Settings' });

  const briefs = loadPrecisionBriefs(cDir);
  const brief = briefs.find(b => b.brief_id === req.params.briefId);
  if (!brief) return res.status(404).json({ error: 'Brief not found' });
  if (!brief.image_prompt) return res.status(400).json({ error: 'Brief has no image_prompt' });

  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

    const contents = [];
    const { referenceImageBase64, referenceImageMime, refinement, clearProductImage } = req.body;

    // 1. Manual reference image (from refinement modal upload) takes priority
    // 2. Otherwise auto-attach the brief's product_image_url if present
    let usedProductImage = null;
    if (referenceImageBase64) {
      contents.push({ inlineData: { mimeType: referenceImageMime || 'image/jpeg', data: referenceImageBase64 } });
    } else if (!clearProductImage && brief.product_image_url) {
      // Load product image from local file system
      try {
        const productImgPath = brief.product_image_url.startsWith('/api/clients/')
          ? path.join(CLIENTS_DIR, req.params.id, 'assets', 'products',
              ...brief.product_image_url.split('/assets/products/')[1].split('/'))
          : null;
        if (productImgPath && fs.existsSync(productImgPath)) {
          const imgData = fs.readFileSync(productImgPath);
          const ext = path.extname(productImgPath).slice(1).toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          contents.push({ inlineData: { mimeType: mime, data: imgData.toString('base64') } });
          usedProductImage = brief.product_image_url;
        }
      } catch (e) {
        console.warn('[generate-image] Could not load product image:', e.message);
      }
    }

    const productNote = usedProductImage
      ? `\n\nIMPORTANT: The attached photo shows the ACTUAL product. Incorporate it naturally into the scene — keep it recognisable and prominent.`
      : '';
    const finalPrompt = refinement
      ? `${brief.image_prompt}${productNote}\n\nIMPORTANT refinements for this version: ${refinement}`
      : `${brief.image_prompt}${productNote}`;
    contents.push({ text: finalPrompt });

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        temperature: 0.4,
      },
    });

    const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart) {
      const textPart = response.candidates?.[0]?.content?.parts?.find(p => p.text);
      return res.status(500).json({ error: 'No image in Gemini response', detail: textPart?.text || JSON.stringify(response).slice(0, 300) });
    }

    const imgDir = path.join(cDir, 'assets', 'precision');
    fs.mkdirSync(imgDir, { recursive: true });
    const filename = `${brief.brief_id}_${Date.now()}.png`;
    fs.writeFileSync(path.join(imgDir, filename), Buffer.from(imagePart.inlineData.data, 'base64'));

    const localUrl = `/api/clients/${req.params.id}/assets/precision/${filename}`;

    // Re-read + patch atomically — prevents concurrent saves clobbering each other
    const updatedBrief = patchPrecisionBrief(cDir, req.params.briefId, {
      image_url: localUrl,
      generated_images: [
        ...(brief.generated_images || []),
        { filename, local_url: localUrl, created_at: new Date().toISOString() },
      ],
    });

    res.json({ ok: true, local_url: localUrl, filename, brief: updatedBrief });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve precision-generated images
app.get('/api/clients/:id/assets/precision/:filename', requireLicense, (req, res) => {
  const filePath = path.join(CLIENTS_DIR, req.params.id, 'assets', 'precision', req.params.filename);
  if (!filePath.startsWith(CLIENTS_DIR)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// POST /api/clients/:id/precision/post/:briefId — fire-and-forget run to post brief + DMs
app.post('/api/clients/:id/precision/post/:briefId', requireLicense, (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const briefs = loadPrecisionBriefs(cDir);
  const brief = briefs.find(b => b.brief_id === req.params.briefId);
  if (!brief) return res.status(404).json({ error: 'Brief not found' });
  if (brief.status !== 'approved' && brief.status !== 'queued') return res.status(400).json({ error: 'Brief must be approved or queued before posting' });

  const command = `precision-post:${req.params.briefId}`;
  const briefIdCapture = req.params.briefId;

  let runResult;
  try {
    runResult = spawnRun(
      req.params.id,
      command,
      () => {}, // output goes to run log file only
      (runId, code, signal, startedAt, status) => {
        // Claude updates precision-briefs.json directly with status+post_url in the prompt.
        // We do NOT override here — a successful exit code does NOT mean the post succeeded.
        console.log(`[precision-post ${briefIdCapture}] run ${runId} finished: ${status} (exit ${code})`);
      }
    );
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.json({ ok: true, runId: runResult.runId, message: `Precision post run started — monitor in Runs tab` });
});

// ─── Client Chat (Claude Messages API streaming) ───
app.post('/api/clients/:id/chat', requireLicense, async (req, res) => {
  const cDir = clientDir(req.params.id);
  if (!fs.existsSync(cDir)) return res.status(404).json({ error: 'Client not found' });

  const config = loadConfig();
  if (!config.anthropicApiKey) return res.status(400).json({ error: 'Anthropic API key not configured' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

  // Build system context from client data
  let clientConfig = {};
  try { clientConfig = JSON.parse(fs.readFileSync(path.join(cDir, 'config.json'), 'utf8')); } catch {}
  const stats = (() => { try { return lgDb.getStats(cDir); } catch { return {}; } })();
  const sources = (() => { try { return lgDb.getHotSources(cDir); } catch { return []; } })();

  const systemPrompt = `You are an AI assistant managing social media lead generation for "${clientConfig.name || 'a client'}".
You have direct access to their pipeline and can give actionable advice.

Current pipeline stats:
- Total leads: ${stats.totalLeads || 0}
- Hot leads (score ≥70): ${stats.hotLeads || 0}
- In pipeline: ${stats.inPipeline || 0}
- Converted: ${stats.conversions || 0}
- DMs sent: ${stats.dmPivots || 0}

Active sources (${sources.filter(s => s.enabled !== false).length}): ${sources.filter(s => s.enabled !== false).map(s => s.platform + ':' + (s.handle_or_url || s.handle_or_tag || '')).slice(0, 10).join(', ')}

Client niche: ${clientConfig.niche || ''}
Target geo: ${clientConfig.target_geo || ''}
Product: ${clientConfig.product_name || ''}

Keep responses concise and actionable. You can suggest running specific commands, adjusting sources, or advancing leads in the pipeline. When the user asks to run something, explain what you'd do and they can trigger it via the Run button.`;

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendSSE = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

  const model = config.anthropicModel || 'claude-haiku-4-5-20251001';
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    stream: true,
    system: systemPrompt,
    messages: messages.slice(-20), // keep last 20 messages for context
  });

  const opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  };

  const apiReq = https.request(opts, apiRes => {
    let buf = '';
    apiRes.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]' || !raw) continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            sendSSE({ type: 'delta', text: evt.delta.text });
          } else if (evt.type === 'message_stop') {
            sendSSE({ type: 'done' });
            res.end();
          } else if (evt.type === 'error') {
            sendSSE({ type: 'error', message: evt.error?.message || 'API error' });
            res.end();
          }
        } catch {}
      }
    });
    apiRes.on('end', () => { sendSSE({ type: 'done' }); try { res.end(); } catch {} });
    apiRes.on('error', err => { sendSSE({ type: 'error', message: err.message }); try { res.end(); } catch {} });
  });

  apiReq.on('error', err => { sendSSE({ type: 'error', message: err.message }); try { res.end(); } catch {} });
  req.on('close', () => { try { apiReq.destroy(); } catch {} });
  apiReq.write(body);
  apiReq.end();
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
