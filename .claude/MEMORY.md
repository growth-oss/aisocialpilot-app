# AI Social Pilot — Project Memory

## Brand
- Product name: **AI Social Pilot**
- Domain: **aisocialpilot.com**
- Contact: hello@aisocialpilot.com

## Project Location
`/Users/S7/Library/CloudStorage/GoogleDrive-claudescrappy@gmail.com/Shared drives/Claude/SocialAIAutomation/`
(symlinked from `~/.claude` to this folder for cross-machine sync)

## Live URLs
- **Main app**: https://aisocialpilot-app-production.up.railway.app/
- **License server**: https://license.aisocialpilot.com (separate Railway service, repo: `growth-oss/aisocialpilot-license`)
- **Git repo**: https://github.com/growth-oss/aisocialpilot-app (auto-deploys on push to `main`)

---

## ⚠️ DO NOT BE CONFUSED BY THESE ROOT FILES
- `index.js` (root) — OLD dev fallback, **not the real server** — ignore it
- `index.html` (root) — OLD simple admin panel, **not the real UI** — ignore it
- `PROJECT_PLAN.md` — OUTDATED phase tracker, **do not use**
- `AI_Dashboard_Features_Spec.html` — REJECTED design (chat-first), **do not implement**
- `AI_Dashboard_Features_Spec2.html` — APPROVED design spec — use as reference for UI work

## Key Source Files (REAL ones)
- `server/index.js` — main Express server (~5000+ lines): all API routes, automation engine, scheduler, SSE streaming, chat endpoint
- `server/scripts/post-via-blotato.js` — **ACTIVE posting script** — posts via Blotato REST API, DMs via Playwright
- `server/scripts/post-to-instagram.js` — legacy Playwright posting (fallback only, not used if Blotato configured)
- `server/leadgen/db.js` — lead gen JSON data store (leads, sources, stats, log)
- `server/leadgen/prompt.js` — builds the Claude prompt for each automation run
- `admin/public/index.html` — all-clients dashboard SPA (~5000 lines)
- `admin/public/client.html` — client detail page (sidebar nav + Claude chat panel + Content tab)
- `Dockerfile` — builds from `mcr.microsoft.com/playwright:v1.58.2-noble`
- `scripts/start.sh` — startup: Xvfb → VNC → noVNC → Node
- `scripts/open-session.js` — opens headed Playwright browser for manual login

---

## Architecture — Docker/Railway
- Express server (`server/index.js`) runs as root (uid 0)
- **Claude Code 2.x blocks `--dangerously-skip-permissions` when uid=0** — must spawn as `claude_runner` user
- Claude CLI spawned via `su -s /bin/bash claude_runner -c /tmp/claude-run-{runId}.sh`
- Temp shell script at `/tmp/` with all env vars exported
- Claude session history cleared before each run: `rm -rf /home/claude_runner/.claude/projects/`
- Railway proxy closes SSE at ~3-9ms — 10s grace period on `req.on('close')` kill handler
- Browser always `headless: false` — Xvfb on `DISPLAY=:99`
- `claude_runner` user auto-assigned uid (NOT 1001 — taken by Playwright base image)
- `/home/claude_runner/.claude/settings.json` written on every startup with `bypassPermissionsModeAccepted: true`
- `/app/data` chmod 777 so claude_runner can write

## Key Railway Env Vars
- `ANTHROPIC_API_KEY` — set via admin setup, stored in `data/config.json`
- `LICENSE_SERVER=https://license.aisocialpilot.com`
- `DATA_DIR=/app/data`
- `PORT=3000`
- `DISPLAY=:99`

---

## Data Layout (per client)
```
data/clients/{clientId}/
  config.json               — client config (name, niche, target_geo, proxy, schedule, etc.)
  leadgen/
    leads.json              — all leads (array), patched in-place
    hot-sources.json        — active lead gen sources
    outreach-log.ndjson     — append-only action log
    leadgen-config.json     — pipeline config (scoring, cooldown, personas, etc.)
  browser-sessions/
    instagram/              — Playwright persistent context (cookies/session)
    tiktok/
    facebook/
    ...
  logs/
    runs/{runId}.log        — full Claude output per run (captured since commit cc968a6)
    scheduled.log
  knowledge/
    products.json, competitors.json, hot-sources.json, keywords.json, followers.json
```

---

## Lead Gen Architecture

### How a run works
1. User clicks "Run" → POST `/api/clients/:id/run` with `command: 'leadgen'`
2. Server writes a temp shell script + runs Claude CLI as `claude_runner`
3. Claude reads `server/leadgen/prompt.js` output — a large context prompt with:
   - Client config (name, niche, target_geo, product, proxy)
   - All hot sources (platform, type, handle/URL)
   - Competitor list
   - Current lead stats + existing leads (to skip already-engaged)
   - Pipeline rules (scoring, engagement ladder, cooldown)
4. Claude browses with Playwright, scrapes leads, engages, writes to `leads.json` via tool calls
5. Each run log saved to `data/clients/{id}/logs/runs/{runId}.log`

### Lead object fields
```json
{
  "id": 1,
  "platform": "instagram",
  "username": "@handle",
  "display_name": "Name",
  "follower_count": 5000,
  "bio_snippet": "...",
  "total_score": 85,
  "engagement_stage": 3,       // 0=New, 1=Story, 2=Liked, 3=Followed, 4=Commented, 5=DM, 6=Reply, 7=Converted
  "last_engaged_at": "ISO",
  "source_type": "competitor_commenter",
  "source_handle": "@competitor",
  "is_converted": 0,
  "is_do_not_engage": 0,
  // Feedback fields (added 2026-03-11):
  "feedback_good": 0,
  "feedback_bad": 0,
  "feedback_purchased": 0,
  "purchase_amount": null,
  "feedback_tags": []
}
```

### Scoring system (from leadgen-config.json)
- UAE/AE in bio: +30
- Arabic language: +20
- Follows competitor: +40
- Comments on competitor: +40
- High follower count (1k–100k): +20
- Interior designer / hospitality: +25
- Existing customer complaint: +85 (hot source)

### Critical fixes already applied (do NOT revert)
1. **Geo check**: use `curl -s -x 'PROXY_URL' --max-time 20 --connect-timeout 15 https://ipinfo.io/json` — NOT whatismyip.com (too slow in headless)
2. **Cooldown**: use `??` not `||` — `0 || 48` = 48 in JS (zero is falsy), `0 ?? 48` = 0
3. **Session dir path**: `browser-sessions/{platform}/` NOT `sessions/{platform}/`
4. **Meta Ads Library**: React SPA — can't extract post URLs from DOM. Use as keyword discovery tool: search "mattress" UAE → get brand names → find their Instagram → scrape their posts
5. **Chrome lock files**: If run fails with "session already open", delete `SingletonLock` in session dir and retry

---

## Admin Dashboard

### index.html (all-clients view at `/`)
- Client card click → opens `/client.html?id=XXX` in new tab
- "Open" button per card → same
- Still has full edit functionality via `editClient()` if needed

### client.html (client detail at `/client.html?id=XXX`)
**NEW as of 2026-03-11** — the main working interface for a client:
- **Left sidebar**: avatar, nav (Overview, Pipeline, Sources, Runs, Settings), Run Now button
- **Overview tab**: KPI cards, source health pills (13 platforms), top pipeline table, conversion funnel, recent runs
- **Pipeline tab**: full leads table with filters (stage, platform), feedback buttons per lead
- **Sources tab**: configured hot-sources with status and last scraped
- **Runs tab**: run history, click row to view full log
- **Settings tab**: links to admin for advanced config
- **Chat panel** (always visible, right side): real Claude streaming chat with client context in system prompt

### Chat panel in client.html
- Endpoint: `POST /api/clients/:id/chat` → SSE stream
- System prompt includes: client name, niche, target_geo, total leads, hot leads, active sources
- Uses Anthropic Messages API directly (not Claude CLI) — fast conversational responses
- Model: claude-haiku-4-5 (configured model)
- Keep last 20 messages in history per browser session

---

## Blotato Integration (ACTIVE — use this for all posting)

**Blotato = the posting layer. Playwright = engagement/scraping/DMs only.**

### Client config structure
```json
{ "blotato": { "api_key": "blt_xxx", "accounts": { "instagram": "35051", "x": "", "linkedin": "", "facebook": "", "tiktok": "", "threads": "", "pinterest": "", "bluesky": "" } } }
```
Legacy flat `blotato.account_id` still works as fallback for Instagram.

### How precision-post works with Blotato
- `spawnRun()` detects `blotato.api_key` + `blotato.accounts.instagram` → sets `directCmd = "node /app/server/scripts/post-via-blotato.js"`
- Shell script runs node directly — **no Claude CLI, no ToolSearch, finishes in ~5s**
- POSTs to `https://backend.blotato.com/v2/posts` with `mediaUrls`, `text`, `accountId`
- DMs (if `DM_LEADS` set) still use Playwright after posting

### Blotato API (backend.blotato.com, header: `blotato-api-key: KEY`)
- `POST /v2/posts` — publish. Body: `{ post: { accountId, content: { text, mediaUrls, platform }, target: { targetType } } }`
- `GET /v2/users/me/accounts` — list connected accounts
- `POST /v2/videos/from-templates` — generate media. Body: `{ templateId, prompt, inputs:{}, render:true }` → `{ item: { id, status } }`
- `GET /v2/videos/creations/{id}` — poll. Returns `{ status:'done', mediaUrl, imageUrls[] }`

### Server routes for Blotato
- `POST /api/clients/:id/blotato/test`
- `GET /api/clients/:id/blotato/templates`
- `POST /api/clients/:id/blotato/generate` — `{ templateId, prompt }`
- `GET /api/clients/:id/blotato/creations/:creationId`

---

## API Routes (complete list)

### Core
- `GET /api/status` — health, license, client count, git commit
- `POST /api/license/activate`
- `POST /api/setup` — save API keys + model prefs
- `GET /api/settings`

### Clients
- `GET/POST /api/clients`
- `PUT/DELETE /api/clients/:id`
- `GET /api/clients/:id/logs`
- `GET /api/clients/:id/costs`

### Runs
- `POST /api/clients/:id/run` — SSE streaming automation
- `POST /api/clients/:id/run/stop`
- `GET /api/clients/:id/run/active`
- `GET /api/clients/:id/runs` — run history (last 20)
- `GET /api/clients/:id/runs/:runId` — full run log text
- `GET /api/clients/:id/next-runs`

### Chat (NEW 2026-03-11)
- `POST /api/clients/:id/chat` — SSE stream, Anthropic Messages API with client context

### Lead Gen
- `GET /api/clients/:id/leadgen/stats`
- `GET /api/clients/:id/leadgen/leads?limit=&stage=&platform=`
- `PATCH /api/clients/:id/leadgen/leads/:leadId` — stage, convert, dnd, notes, **feedback** (NEW)
- `DELETE /api/clients/:id/leadgen/leads/:leadId`
- `GET /api/clients/:id/leadgen/config`
- `PUT /api/clients/:id/leadgen/config`
- `GET /api/clients/:id/leadgen/next-run`
- `GET /api/clients/:id/leadgen/log`
- `GET /api/clients/:id/leadgen/competitor-view`
- `DELETE /api/clients/:id/leadgen/leads` — clear all

### Sessions & Proxy
- `POST /api/clients/:id/session/start`
- `POST /api/clients/:id/session/stop`
- `GET /api/clients/:id/sessions`
- `GET /api/clients/:id/proxy-test`

### Intelligence
- `GET/PUT /api/clients/:id/knowledge/:section`
- `POST /api/clients/:id/knowledge/products/import`
- `POST /api/clients/:id/intel/run`
- `GET /api/clients/:id/intel/jobs`
- `GET /api/clients/:id/intel/jobs/:runId/stream`
- `GET /api/clients/:id/intel/jobs/:runId/tail`
- `DELETE /api/clients/:id/intel/jobs/:runId`
- `GET /api/clients/:id/intel/hunt-history`
- `GET /api/clients/:id/intel/last-run`

### Hunt settings, Backup, SMTP
- `GET/PUT /api/clients/:id/hunt-settings`
- `GET /api/clients/:id/hunt-settings/budget`
- `POST /api/clients/:id/hunt-settings/budget/reset`
- `POST /api/settings/smtp-test`
- `GET/POST /api/backup/status|run|download|restore`

---

## Sources — What's Working

| Platform | Source Type | Status | Notes |
|----------|-------------|--------|-------|
| Instagram | competitor_commenter | ✅ Working | Main source, UAE proxy required |
| Instagram | tagged_posts | ✅ Working | Search by hashtag |
| Instagram | location_posts | ✅ Working | Location ID scraping |
| Meta Ads Library | competitor_ad_commenter | ⚠ Partial | Use as brand discovery only (React SPA), then scrape their IG |
| Google Maps | business_leads | 🔧 TODO | Scrape business listings by keyword + location |
| LinkedIn | profile_scraper | 🔧 TODO | Interior designers, hospitality buyers UAE |
| Facebook | group_members | 🔧 TODO | Home decor UAE groups |
| TikTok | video_commenters | 🔧 TODO | Session required |
| Dubizzle | furnished_apt_listings | 🔧 TODO | Property listings = bedding buyers |
| Google Search | organic | 🔧 TODO | "bamboo bedding UAE" searchers via ads |
| Quora | question_answerers | 🔧 TODO | Sleep/bedding questions |
| Pinterest | pin_savers | 🔧 TODO | Home decor intent |
| YouTube | youtube_video_commenter, youtube_channel_commenter | ✅ Working | keyword search + channel scraping, discovery only (no engagement on YT) |

**To add a new source:**
1. Add entry to client's `hot-sources.json` (or via admin UI → Lead Gen → Sources)
2. The prompt in `server/leadgen/prompt.js` already supports any platform — just add the source
3. For scraping logic: Claude figures it out from the source type + handle. The prompt instructs Claude to handle `type: 'account'`, `type: 'hashtag'`, `type: 'location'`, `type: 'keyword'`, `type: 'meta_ads'`
4. New platform session dirs go in `browser-sessions/{platform}/`

---

## Current Client: Bamboo Sleep Professor
- **Brand**: DrSleeep bamboo bedding (UAE)
- **Ambassador**: Nada Ali → @bamboo_sleep_professor (Instagram)
- **Target**: Interior designers, hotel procurement, home buyers in UAE
- **Proxy**: UAE residential proxy (required — AE geo)
- **Lead count**: ~36 leads as of last session (stages 3–4, need to reach DM)
- **Next steps**: advance leads from stage 3 (followed) → stage 4 (comment) → stage 5 (DM)

---

## License System
- Dev bypass key: `SP-DEV-LOCAL-2026` (bypasses license server, use for local testing)
- Live key: Pro plan, 10 clients max
- Status confirmed: `licenseValid: true, licensePlan: pro, maxClients: 10`

## Debugging
- `/api/debug-claude` — tests claude CLI runs as claude_runner
- `/api/status` — includes git commit hash for deploy verification
- Run logs: `data/clients/{id}/logs/runs/{runId}.log`
- Check active run: `GET /api/clients/:id/run/active`
- Lead gen log: `GET /api/clients/:id/leadgen/log`

## currentDate
Today's date is 2026-03-14.
