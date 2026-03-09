'use strict';
// ─── Lead Gen — JSON data store ───────────────────────────────────────────────
// No native compilation — pure Node.js built-ins only.
//
// Files per client  (under {clientDir}/leadgen/):
//   leads.json       — array of lead objects, rewritten on every change
//   outreach-log.ndjson — append-only newline-delimited JSON
//   hot-sources.json — seeded from templates, managed via config API
//
// Scale: fine for thousands of leads per client on Railway volumes.

const fs   = require('fs');
const path = require('path');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lgDir(clientDir) {
  const d = path.join(clientDir, 'leadgen');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function leadsPath(clientDir) { return path.join(lgDir(clientDir), 'leads.json'); }
function logPath(clientDir)   { return path.join(lgDir(clientDir), 'outreach-log.ndjson'); }
function srcPath(clientDir)   { return path.join(lgDir(clientDir), 'hot-sources.json'); }

// Atomic write: write to a tmp file then rename so reads never see partial data
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ─── Leads ───────────────────────────────────────────────────────────────────

function loadLeads(clientDir) {
  const p = leadsPath(clientDir);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function saveLeads(clientDir, leads) {
  atomicWrite(leadsPath(clientDir), leads);
}

function nextId(leads) {
  return leads.length ? Math.max(...leads.map(l => l.id)) + 1 : 1;
}

function now() { return new Date().toISOString(); }

// Insert or update by (platform, username). Returns the upserted lead.
function upsertLead(clientDir, lead) {
  const leads = loadLeads(clientDir);
  const idx   = leads.findIndex(l => l.platform === lead.platform && l.username === lead.username);

  if (idx !== -1) {
    const existing = leads[idx];
    leads[idx] = {
      ...existing,
      profile_url:     lead.profile_url     ?? existing.profile_url,
      display_name:    lead.display_name    ?? existing.display_name,
      follower_count:  lead.follower_count  ?? existing.follower_count,
      following_count: lead.following_count ?? existing.following_count,
      bio_snippet:     lead.bio_snippet     ?? existing.bio_snippet,
      total_score:     Math.max(existing.total_score || 0, lead.total_score || 0),
      is_influencer:   lead.is_influencer   ?? existing.is_influencer,
      updated_at:      now(),
    };
    saveLeads(clientDir, leads);
    return leads[idx];
  }

  const newLead = {
    id:               nextId(leads),
    platform:         lead.platform,
    username:         lead.username,
    profile_url:      lead.profile_url      || null,
    display_name:     lead.display_name     || null,
    follower_count:   lead.follower_count   || 0,
    following_count:  lead.following_count  || 0,
    bio_snippet:      lead.bio_snippet      || null,
    total_score:      lead.total_score      || 0,
    is_influencer:    lead.is_influencer    ? 1 : 0,
    engagement_stage: 0,
    last_engaged_at:  null,
    dm_pivot_attempted: 0,
    dm_channel:       null,
    coupon_referenced: 0,
    coupon_code:      null,
    urgency_used:     0,
    is_converted:     0,
    converted_at:     null,
    is_do_not_engage: 0,
    source_type:      lead.source_type  || null,
    source_handle:    lead.source_handle || null,
    notes:            lead.notes        || null,
    created_at:       now(),
    updated_at:       now(),
  };
  leads.push(newLead);
  saveLeads(clientDir, leads);
  return newLead;
}

function updateLeadStage(clientDir, leadId, stage, extra = {}) {
  const leads = loadLeads(clientDir);
  const idx   = leads.findIndex(l => l.id === leadId);
  if (idx === -1) return;

  leads[idx] = {
    ...leads[idx],
    engagement_stage:    stage,
    last_engaged_at:     now(),
    updated_at:          now(),
    ...(extra.dm_pivot_attempted !== undefined && { dm_pivot_attempted: extra.dm_pivot_attempted ? 1 : 0 }),
    ...(extra.dm_channel         !== undefined && { dm_channel: extra.dm_channel }),
    ...(extra.coupon_referenced  !== undefined && { coupon_referenced: extra.coupon_referenced ? 1 : 0 }),
    ...(extra.coupon_code        !== undefined && { coupon_code: extra.coupon_code }),
    ...(extra.urgency_used       !== undefined && { urgency_used: extra.urgency_used ? 1 : 0 }),
    ...(extra.notes              !== undefined && { notes: extra.notes }),
  };
  saveLeads(clientDir, leads);
}

function markConverted(clientDir, leadId) {
  const leads = loadLeads(clientDir);
  const idx   = leads.findIndex(l => l.id === leadId);
  if (idx === -1) return;
  leads[idx] = { ...leads[idx], is_converted: 1, converted_at: now(), updated_at: now() };
  saveLeads(clientDir, leads);
}

function markDoNotEngage(clientDir, leadId) {
  const leads = loadLeads(clientDir);
  const idx   = leads.findIndex(l => l.id === leadId);
  if (idx === -1) return;
  leads[idx] = { ...leads[idx], is_do_not_engage: 1, updated_at: now() };
  saveLeads(clientDir, leads);
}

function deleteLead(clientDir, leadId) {
  const leads = loadLeads(clientDir).filter(l => l.id !== leadId);
  saveLeads(clientDir, leads);
}

function getLeads(clientDir, { platform, stage, minScore, converted, source_handle, limit = 100, offset = 0 } = {}) {
  let leads = loadLeads(clientDir).filter(l => !l.is_do_not_engage);

  if (platform !== undefined && platform !== null && platform !== '')
    leads = leads.filter(l => l.platform === platform);
  if (stage !== undefined && stage !== null)
    leads = leads.filter(l => l.engagement_stage === stage);
  if (minScore !== undefined)
    leads = leads.filter(l => l.total_score >= minScore);
  if (converted !== undefined)
    leads = leads.filter(l => (l.is_converted ? 1 : 0) === (converted ? 1 : 0));
  if (source_handle !== undefined && source_handle !== null && source_handle !== '') {
    const h = source_handle.replace(/^@/, '').toLowerCase();
    leads = leads.filter(l => l.source_handle && l.source_handle.replace(/^@/, '').toLowerCase() === h);
  }

  leads.sort((a, b) => {
    if (b.total_score !== a.total_score) return b.total_score - a.total_score;
    return (b.last_engaged_at || '').localeCompare(a.last_engaged_at || '');
  });

  return leads.slice(offset, offset + limit);
}

function getLeadById(clientDir, leadId) {
  return loadLeads(clientDir).find(l => l.id === leadId) || null;
}

function wasEngagedWithinHours(clientDir, platform, username, hours) {
  const lead = loadLeads(clientDir).find(l => l.platform === platform && l.username === username);
  if (!lead || !lead.last_engaged_at) return false;
  return (Date.now() - new Date(lead.last_engaged_at).getTime()) / 3600000 < hours;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function getStats(clientDir) {
  const leads  = loadLeads(clientDir);
  const active = leads.filter(l => !l.is_do_not_engage);

  const totalLeads  = active.length;
  const hotLeads    = active.filter(l => l.total_score >= 70).length;
  const inPipeline  = active.filter(l => l.engagement_stage > 0 && !l.is_converted).length;
  const conversions = leads.filter(l => l.is_converted).length;
  const dmPivots    = leads.filter(l => l.dm_pivot_attempted).length;
  const couponUsed  = leads.filter(l => l.coupon_referenced).length;
  const influencers = active.filter(l => l.is_influencer).length;

  const stageCounts = {};
  for (const l of active) {
    const s = l.engagement_stage || 0;
    stageCounts[s] = (stageCounts[s] || 0) + 1;
  }
  const byStage = Object.entries(stageCounts).map(([stage, n]) => ({ stage: Number(stage), n }));

  const platformCounts = {};
  for (const l of active) platformCounts[l.platform] = (platformCounts[l.platform] || 0) + 1;
  const byPlatform = Object.entries(platformCounts).map(([platform, n]) => ({ platform, n }))
    .sort((a, b) => b.n - a.n);

  const recentLog = getLog(clientDir, { limit: 20 });

  return { totalLeads, hotLeads, inPipeline, conversions, dmPivots, couponUsed, influencers, byStage, byPlatform, recentLog };
}

// ─── Outreach log ─────────────────────────────────────────────────────────────
// NDJSON: one JSON object per line, append-only. Fast writes, read-from-end for recent.

function logAction(clientDir, entry) {
  const line = JSON.stringify({
    id:            Date.now(),
    lead_id:       entry.lead_id    || null,
    platform:      entry.platform,
    action_type:   entry.action_type,
    post_url:      entry.post_url   || null,
    content_used:  entry.content_used || null,
    persona_id:    entry.persona_id || null,
    proxy_verified: entry.proxy_verified ? 1 : 0,
    success:       entry.success !== false ? 1 : 0,
    error_msg:     entry.error_msg || null,
    username:      entry.username   || null,
    display_name:  entry.display_name || null,
    timestamp:     now(),
  }) + '\n';
  fs.appendFileSync(logPath(clientDir), line);
}

function getLog(clientDir, { limit = 50, offset = 0, username } = {}) {
  const p = logPath(clientDir);
  if (!fs.existsSync(p)) return [];

  let lines = fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reverse(); // newest first

  const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const filtered = username ? parsed.filter(e => e.username === username) : parsed;
  return filtered.slice(offset, offset + limit);
}

// Returns pipeline stats + recent leads for one competitor source handle
function getCompetitorView(clientDir, handle) {
  const STAGE_LABELS = ['Discovered','Story Viewed','Liked','Followed','Commented','DM Sent','DM Replied','Converted'];
  const h = (handle || '').replace(/^@/, '').toLowerCase();

  const allLeads = loadLeads(clientDir).filter(l => !l.is_do_not_engage);
  const leads = allLeads.filter(l => l.source_handle && l.source_handle.replace(/^@/, '').toLowerCase() === h);

  const stageCounts = {};
  for (let i = 0; i <= 7; i++) stageCounts[i] = 0;
  leads.forEach(l => { const s = Math.min(l.engagement_stage || 0, 7); stageCounts[s]++; });

  const pipeline = STAGE_LABELS.map((label, i) => ({ stage: i, label, count: stageCounts[i] }));
  const activeDMs = leads.filter(l => l.engagement_stage >= 5).sort((a, b) => (b.last_engaged_at || '').localeCompare(a.last_engaged_at || ''));
  const recentLeads = [...leads].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 60);

  return {
    totalFound:   leads.length,
    inPipeline:   leads.filter(l => l.engagement_stage > 0 && !l.is_converted).length,
    dmsSent:      leads.filter(l => l.engagement_stage >= 5).length,
    converted:    leads.filter(l => l.is_converted).length,
    pipeline,
    activeDMs,
    recentLeads,
  };
}

// ─── Hot sources ──────────────────────────────────────────────────────────────

function loadSources(clientDir) {
  const p = srcPath(clientDir);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function saveSources(clientDir, sources) {
  atomicWrite(srcPath(clientDir), sources);
}

function upsertHotSource(clientDir, src) {
  const sources = loadSources(clientDir);
  const idx     = sources.findIndex(
    s => s.platform === src.platform && s.source_type === src.source_type && s.handle_or_tag === src.handle_or_tag
  );
  if (idx !== -1) {
    sources[idx] = { ...sources[idx], enabled: src.enabled !== false };
  } else {
    sources.push({
      platform:      src.platform,
      source_type:   src.source_type,
      handle_or_tag: src.handle_or_tag,
      enabled:       src.enabled !== false,
      last_scraped_at:   null,
      posts_scraped:     0,
      targets_generated: 0,
    });
  }
  saveSources(clientDir, sources);
}

function touchHotSource(clientDir, platform, sourceType, handleOrTag, postsScraped, targetsGenerated) {
  const sources = loadSources(clientDir);
  const idx     = sources.findIndex(
    s => s.platform === platform && s.source_type === sourceType && s.handle_or_tag === handleOrTag
  );
  if (idx !== -1) {
    sources[idx].last_scraped_at    = now();
    sources[idx].posts_scraped      = (sources[idx].posts_scraped || 0) + postsScraped;
    sources[idx].targets_generated  = (sources[idx].targets_generated || 0) + targetsGenerated;
    saveSources(clientDir, sources);
  }
}

function getHotSources(clientDir, { platform } = {}) {
  let s = loadSources(clientDir);
  if (platform) s = s.filter(x => x.platform === platform);
  return s;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
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
  // competitor 360
  getCompetitorView,
  // hot sources
  upsertHotSource,
  touchHotSource,
  getHotSources,
};
