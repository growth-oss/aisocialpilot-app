'use strict';
// ─── Lead Gen — Database Module ──────────────────────────────────────────────
// One SQLite database per client at: {clientDir}/leadgen/leadgen.db
// Uses better-sqlite3 (sync API) — no async complexity.
//
// Tables:
//   leads          — every discovered user + their pipeline stage
//   outreach_log   — every action taken (like, follow, comment, DM, coupon)
//   hot_sources    — competitor handles + hashtags to mine

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS leads (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  platform             TEXT    NOT NULL,
  username             TEXT    NOT NULL,
  profile_url          TEXT,
  display_name         TEXT,
  follower_count       INTEGER DEFAULT 0,
  following_count      INTEGER DEFAULT 0,
  bio_snippet          TEXT,
  -- scoring
  total_score          INTEGER DEFAULT 0,
  is_influencer        INTEGER DEFAULT 0,
  -- pipeline
  engagement_stage     INTEGER DEFAULT 0,
  -- 0=discovered, 1=story_viewed, 2=liked, 3=followed,
  -- 4=commented, 5=replied_question, 6=dm_sent
  last_engaged_at      TEXT,
  -- conversion
  dm_pivot_attempted   INTEGER DEFAULT 0,
  dm_channel           TEXT,
  coupon_referenced    INTEGER DEFAULT 0,
  coupon_code          TEXT,
  urgency_used         INTEGER DEFAULT 0,
  is_converted         INTEGER DEFAULT 0,
  converted_at         TEXT,
  -- admin
  is_do_not_engage     INTEGER DEFAULT 0,
  source_type          TEXT,
  -- competitor_commenter | competitor_liker | hashtag | manual
  source_handle        TEXT,
  notes                TEXT,
  created_at           TEXT DEFAULT (datetime('now')),
  updated_at           TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, username)
);

CREATE INDEX IF NOT EXISTS idx_leads_stage    ON leads(engagement_stage);
CREATE INDEX IF NOT EXISTS idx_leads_score    ON leads(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_platform ON leads(platform);
CREATE INDEX IF NOT EXISTS idx_leads_converted ON leads(is_converted);

CREATE TABLE IF NOT EXISTS outreach_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  action_type  TEXT NOT NULL,
  -- story_view | like | follow | comment | reply | dm | dm_pivot | coupon_sent
  post_url     TEXT,
  content_used TEXT,
  persona_id   TEXT,
  proxy_verified INTEGER DEFAULT 0,
  success      INTEGER DEFAULT 1,
  error_msg    TEXT,
  timestamp    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_log_lead_id  ON outreach_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_log_ts       ON outreach_log(timestamp DESC);

CREATE TABLE IF NOT EXISTS hot_sources (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  platform           TEXT NOT NULL,
  source_type        TEXT NOT NULL,   -- competitor | hashtag
  handle_or_tag      TEXT NOT NULL,
  last_scraped_at    TEXT,
  posts_scraped      INTEGER DEFAULT 0,
  targets_generated  INTEGER DEFAULT 0,
  enabled            INTEGER DEFAULT 1,
  UNIQUE(platform, source_type, handle_or_tag)
);
`;

// ─── DB pool — one open handle per client ────────────────────────────────────

const pool = new Map(); // clientId → Database instance

function getDb(clientDir) {
  const dbDir  = path.join(clientDir, 'leadgen');
  const dbPath = path.join(dbDir, 'leadgen.db');

  if (pool.has(dbPath)) return pool.get(dbPath);

  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(dbPath);
  db.exec(SCHEMA);
  pool.set(dbPath, db);
  return db;
}

// ─── Leads ───────────────────────────────────────────────────────────────────

function upsertLead(clientDir, lead) {
  const db = getDb(clientDir);
  const stmt = db.prepare(`
    INSERT INTO leads (
      platform, username, profile_url, display_name,
      follower_count, following_count, bio_snippet,
      total_score, is_influencer,
      source_type, source_handle, notes
    ) VALUES (
      @platform, @username, @profile_url, @display_name,
      @follower_count, @following_count, @bio_snippet,
      @total_score, @is_influencer,
      @source_type, @source_handle, @notes
    )
    ON CONFLICT(platform, username) DO UPDATE SET
      profile_url    = excluded.profile_url,
      display_name   = excluded.display_name,
      follower_count = excluded.follower_count,
      following_count= excluded.following_count,
      bio_snippet    = excluded.bio_snippet,
      total_score    = MAX(leads.total_score, excluded.total_score),
      is_influencer  = excluded.is_influencer,
      updated_at     = datetime('now')
    RETURNING *
  `);
  return stmt.get({
    platform: lead.platform,
    username: lead.username,
    profile_url: lead.profile_url || null,
    display_name: lead.display_name || null,
    follower_count: lead.follower_count || 0,
    following_count: lead.following_count || 0,
    bio_snippet: lead.bio_snippet || null,
    total_score: lead.total_score || 0,
    is_influencer: lead.is_influencer ? 1 : 0,
    source_type: lead.source_type || null,
    source_handle: lead.source_handle || null,
    notes: lead.notes || null,
  });
}

function updateLeadStage(clientDir, leadId, stage, extra = {}) {
  const db = getDb(clientDir);
  const fields = [
    'engagement_stage = @stage',
    'last_engaged_at = datetime(\'now\')',
    'updated_at = datetime(\'now\')',
  ];
  const params = { stage, leadId };

  if (extra.dm_pivot_attempted !== undefined) {
    fields.push('dm_pivot_attempted = @dm_pivot_attempted');
    params.dm_pivot_attempted = extra.dm_pivot_attempted ? 1 : 0;
  }
  if (extra.dm_channel !== undefined) {
    fields.push('dm_channel = @dm_channel');
    params.dm_channel = extra.dm_channel;
  }
  if (extra.coupon_referenced !== undefined) {
    fields.push('coupon_referenced = @coupon_referenced');
    params.coupon_referenced = extra.coupon_referenced ? 1 : 0;
  }
  if (extra.coupon_code !== undefined) {
    fields.push('coupon_code = @coupon_code');
    params.coupon_code = extra.coupon_code;
  }
  if (extra.urgency_used !== undefined) {
    fields.push('urgency_used = @urgency_used');
    params.urgency_used = extra.urgency_used ? 1 : 0;
  }
  if (extra.notes !== undefined) {
    fields.push('notes = @notes');
    params.notes = extra.notes;
  }

  db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = @leadId`).run(params);
}

function markConverted(clientDir, leadId) {
  getDb(clientDir).prepare(`
    UPDATE leads
    SET is_converted = 1, converted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = @leadId
  `).run({ leadId });
}

function markDoNotEngage(clientDir, leadId) {
  getDb(clientDir).prepare(`
    UPDATE leads SET is_do_not_engage = 1, updated_at = datetime('now') WHERE id = @leadId
  `).run({ leadId });
}

function deleteLead(clientDir, leadId) {
  getDb(clientDir).prepare('DELETE FROM leads WHERE id = @leadId').run({ leadId });
}

function getLeads(clientDir, { platform, stage, minScore, converted, limit = 100, offset = 0 } = {}) {
  const db     = getDb(clientDir);
  const where  = ['is_do_not_engage = 0'];
  const params = {};

  if (platform) { where.push('platform = @platform'); params.platform = platform; }
  if (stage !== undefined && stage !== null) { where.push('engagement_stage = @stage'); params.stage = stage; }
  if (minScore !== undefined) { where.push('total_score >= @minScore'); params.minScore = minScore; }
  if (converted !== undefined) { where.push('is_converted = @converted'); params.converted = converted ? 1 : 0; }

  params.limit  = limit;
  params.offset = offset;

  return db.prepare(`
    SELECT * FROM leads
    WHERE ${where.join(' AND ')}
    ORDER BY total_score DESC, last_engaged_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
}

function getLeadById(clientDir, leadId) {
  return getDb(clientDir).prepare('SELECT * FROM leads WHERE id = @leadId').get({ leadId });
}

// Check if a user was engaged recently (for cooldown enforcement)
function wasEngagedWithinHours(clientDir, platform, username, hours) {
  const db  = getDb(clientDir);
  const row = db.prepare(`
    SELECT last_engaged_at FROM leads
    WHERE platform = @platform AND username = @username AND last_engaged_at IS NOT NULL
  `).get({ platform, username });
  if (!row) return false;
  const diff = (Date.now() - new Date(row.last_engaged_at).getTime()) / 3600000;
  return diff < hours;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function getStats(clientDir) {
  const db = getDb(clientDir);

  const totalLeads    = db.prepare('SELECT COUNT(*) as n FROM leads WHERE is_do_not_engage=0').get().n;
  const hotLeads      = db.prepare('SELECT COUNT(*) as n FROM leads WHERE total_score >= 70 AND is_do_not_engage=0').get().n;
  const inPipeline    = db.prepare('SELECT COUNT(*) as n FROM leads WHERE engagement_stage > 0 AND is_converted=0 AND is_do_not_engage=0').get().n;
  const conversions   = db.prepare('SELECT COUNT(*) as n FROM leads WHERE is_converted=1').get().n;
  const dmPivots      = db.prepare('SELECT COUNT(*) as n FROM leads WHERE dm_pivot_attempted=1').get().n;
  const couponUsed    = db.prepare('SELECT COUNT(*) as n FROM leads WHERE coupon_referenced=1').get().n;
  const influencers   = db.prepare('SELECT COUNT(*) as n FROM leads WHERE is_influencer=1 AND is_do_not_engage=0').get().n;

  const byStage = db.prepare(`
    SELECT engagement_stage as stage, COUNT(*) as n
    FROM leads WHERE is_do_not_engage=0
    GROUP BY engagement_stage ORDER BY engagement_stage
  `).all();

  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as n
    FROM leads WHERE is_do_not_engage=0
    GROUP BY platform ORDER BY n DESC
  `).all();

  const recentLog = db.prepare(`
    SELECT ol.*, l.username, l.platform as lead_platform
    FROM outreach_log ol
    LEFT JOIN leads l ON l.id = ol.lead_id
    ORDER BY ol.timestamp DESC LIMIT 20
  `).all();

  return {
    totalLeads, hotLeads, inPipeline, conversions,
    dmPivots, couponUsed, influencers,
    byStage, byPlatform, recentLog,
  };
}

// ─── Outreach log ────────────────────────────────────────────────────────────

function logAction(clientDir, entry) {
  getDb(clientDir).prepare(`
    INSERT INTO outreach_log
      (lead_id, platform, action_type, post_url, content_used, persona_id, proxy_verified, success, error_msg)
    VALUES
      (@lead_id, @platform, @action_type, @post_url, @content_used, @persona_id, @proxy_verified, @success, @error_msg)
  `).run({
    lead_id:       entry.lead_id || null,
    platform:      entry.platform,
    action_type:   entry.action_type,
    post_url:      entry.post_url || null,
    content_used:  entry.content_used || null,
    persona_id:    entry.persona_id || null,
    proxy_verified: entry.proxy_verified ? 1 : 0,
    success:       entry.success !== false ? 1 : 0,
    error_msg:     entry.error_msg || null,
  });
}

function getLog(clientDir, { limit = 50, offset = 0 } = {}) {
  return getDb(clientDir).prepare(`
    SELECT ol.*, l.username, l.display_name
    FROM outreach_log ol
    LEFT JOIN leads l ON l.id = ol.lead_id
    ORDER BY ol.timestamp DESC
    LIMIT @limit OFFSET @offset
  `).all({ limit, offset });
}

// ─── Hot sources ──────────────────────────────────────────────────────────────

function upsertHotSource(clientDir, src) {
  getDb(clientDir).prepare(`
    INSERT INTO hot_sources (platform, source_type, handle_or_tag, enabled)
    VALUES (@platform, @source_type, @handle_or_tag, @enabled)
    ON CONFLICT(platform, source_type, handle_or_tag) DO UPDATE SET
      enabled = excluded.enabled
  `).run({
    platform:      src.platform,
    source_type:   src.source_type,
    handle_or_tag: src.handle_or_tag,
    enabled:       src.enabled !== false ? 1 : 0,
  });
}

function touchHotSource(clientDir, platform, sourceType, handleOrTag, postsScraped, targetsGenerated) {
  getDb(clientDir).prepare(`
    UPDATE hot_sources
    SET last_scraped_at = datetime('now'),
        posts_scraped = posts_scraped + @postsScraped,
        targets_generated = targets_generated + @targetsGenerated
    WHERE platform = @platform AND source_type = @sourceType AND handle_or_tag = @handleOrTag
  `).run({ platform, sourceType, handleOrTag, postsScraped, targetsGenerated });
}

function getHotSources(clientDir, { platform } = {}) {
  const db    = getDb(clientDir);
  const where = platform ? 'WHERE platform = ?' : '';
  const args  = platform ? [platform] : [];
  return db.prepare(`SELECT * FROM hot_sources ${where} ORDER BY platform, source_type`).all(...args);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getDb,
  // leads
  upsertLead,
  updateLeadStage,
  markConverted,
  markDoNotEngage,
  deleteLead,
  getLeads,
  getLeadById,
  wasEngagedWithinHours,
  // stats
  getStats,
  // log
  logAction,
  getLog,
  // hot sources
  upsertHotSource,
  touchHotSource,
  getHotSources,
};
