# AI Social Pilot — Current Project State
**Last updated: 2026-03-14**

> Read this at the start of any new session to understand where we are.
> For full technical details: `.claude/MEMORY.md`
> For automation run rules: `.claude/CLAUDE.md`

---

## What This Is
A self-hosted social media automation + lead generation platform with a full web admin panel.
- Admin panel: `admin/public/index.html` (all clients) + `admin/public/client.html` (per-client detail)
- Server: `server/index.js` (Express, ~5000+ lines)
- Lead gen engine: `server/leadgen/prompt.js` (Claude prompt) + `server/leadgen/db.js` (data)
- Deployed on Railway, Docker, auto-deploys on `git push origin main`
- Live: https://aisocialpilot-app-production.up.railway.app/

## Active Client
- **Bamboo Sleep Professor** — DrSleeep bamboo bedding UAE
- Ambassador: Nada Ali → @bamboo_sleep_professor (Instagram)
- Target: Interior designers, hotel procurement, home buyers in UAE
- ~36 leads in pipeline (stages 3–4 — followed, need DMs)

## What's Working ✅
- Instagram lead gen (competitor scraping, hashtag, location) — UAE proxy, headed browser
- Lead pipeline with 8 stages (New → Converted)
- Admin dashboard with client management
- Client detail page (`/client.html`) — sidebar nav, Claude chat panel, lead feedback
- Run history with full log viewer + live run status
- Anthropic Messages API chat endpoint for client conversations
- Browser session management via VNC
- Scheduler (per-platform UTC times, checks every 60s)
- License system
- **Blotato posting** (ACTIVE — replaces Playwright for all posts):
  - Posts via REST API (`server/scripts/post-via-blotato.js`) — no browser needed
  - Runs as direct node script — finishes in ~5s, no hanging Claude session
  - Configured in Settings tab → Blotato card (API key + account IDs for 8 platforms)
  - Image/video generation via Blotato templates (🎬 Blotato button on each brief)
  - DMs still use Playwright after posting
  - Fallback: `post-to-instagram.js` (Playwright) used only if Blotato not configured
- **Precision Content Engine** (Content tab):
  - Cluster leads by pain point → generate brief (Claude Sonnet)
  - Generate image with Gemini (`gemini-3.1-flash-image-preview` via `@google/genai` SDK)
  - OR generate via Blotato templates (🎬 button → template ID + prompt → poll → preview → save)
  - Image refinement prompt on re-generate
  - Approve → queue → post via Blotato API (instant, no browser)
  - Product carousel briefs: multiple product images, no AI generation needed
  - Re-queue button for failed briefs
  - Screenshots tab (📷) to review run screenshots
  - DM target leads after posting
  - chatNotify persistent activity feed for all actions
- **Smart Auto-Schedule** (Overview tab):
  - 3 configurable GST time windows (e.g. 08:00–10:00, 13:00–15:00, 19:00–21:00)
  - One random run time generated per window each day → written to `schedule.leadgen`
  - Midnight UTC regenerates new random times daily
  - Shows today's run times + "Next run in X hours" countdown
  - On/off toggle + window editor in Overview tab
  - Startup check: generates schedule if today's hasn't been set yet

## What's NOT Done Yet 🔧
| Source | Status | Notes |
|--------|--------|-------|
| Instagram | ✅ Working | Priority #1 source |
| Meta Ads Library | ⚠ Partial | Use for brand discovery only, not post URL scraping |
| Google Maps | 🔧 TODO | Business listing scraper — no session needed |
| LinkedIn | 🔧 TODO | Interior designers + procurement UAE |
| Facebook Groups | 🔧 TODO | Home decor UAE groups |
| TikTok | 🔧 TODO | Session required, high bot detection |
| Dubizzle | 🔧 TODO | Furnished apartment listings |
| Pinterest | 🔧 TODO | Home decor board savers |
| YouTube | ✅ Working | Keyword search + channel scraping → commenters. Discovery only, no YT engagement. Google session shared with Maps/Search. |
| Quora | 🔧 TODO | Sleep quality question askers |

## Architecture Gotchas (read before coding)
1. **Geo check**: use `curl -s -x "$PROXY" --max-time 20 https://ipinfo.io/json` — NOT browser/whatismyip
2. **Session dirs**: `browser-sessions/{platform}/` — NOT `sessions/{platform}/`
3. **Cooldown JS**: use `??` not `||` (zero is falsy in JS)
4. **Meta Ads Library**: React SPA — extract brand names → find their Instagram → scrape posts
5. **Claude runs as `claude_runner` user** (not root) via `su -s /bin/bash claude_runner`
6. **client.html** is served as static file (express.static), does NOT need a server route
7. **Gemini image gen**: use `@google/genai` SDK, model `gemini-3.1-flash-image-preview`, `responseModalities: ['TEXT', 'IMAGE']`
8. **Brief ID field**: briefs stored with `brief_id` (not `id`) — always use `b.brief_id || b.id`
9. **Brief status flow**: `pending` → `queued` (Approve) → `posted` (script marks directly)
10. **Smart schedule GST offset**: GST = UTC+4. Windows stored in GST, written to schedule as UTC.
11. **Blotato posting is direct** — `spawnRun()` sets `directCmd` for Blotato briefs, bypassing Claude CLI entirely. Run log still written, shows `model: direct, cost: $0`.
12. **image_url absolute URLs**: if `brief.image_url` starts with `https://`, passed directly to Blotato — NOT wrapped in `/public/precision/` endpoint. Local filenames ARE wrapped.
13. **Blotato account IDs**: stored as `blotato.accounts.{platform}` in config.json. Legacy `blotato.account_id` still works for Instagram as fallback.

## Key Bugs Fixed (do NOT revert)
- Geo check timeout: 20s not 10s, curl not browser
- Cooldown `??` operator
- Session dir path: browser-sessions not sessions
- Run log capture: each run writes to `logs/runs/{runId}.log`
- getAuthHeaders removed from run log modal fetch
- Brief ID mismatch: server stores `brief_id`, UI must use `b.brief_id || b.id`
- JSON parse failure on Arabic/emoji in briefs: simplified schema, partial-parse fallback
- Concurrent image generation race: `patchPrecisionBrief()` re-reads file before write
- Gemini image gen: wrong model name + wrong SDK call → fixed with `@google/genai`
- Posting run never terminated: Blotato posts now run as direct node script (no Claude CLI)
- image_url wrapping: absolute URLs passed directly to Blotato, not re-wrapped in local endpoint

## Key Files
| File | Purpose |
|------|---------|
| `server/index.js` | Express server, all API endpoints, schedulers |
| `server/scripts/post-via-blotato.js` | **ACTIVE** — Blotato REST posting + Playwright DMs |
| `server/scripts/post-to-instagram.js` | Fallback Playwright posting (only if Blotato not set) |
| `server/leadgen/prompt.js` | Claude prompt for leadgen runs (Phases A–D) |
| `server/leadgen/db.js` | Lead pipeline DB operations |
| `admin/public/client.html` | Per-client dashboard (all tabs) |
| `admin/public/index.html` | Global admin (client list, settings) |
| `data/clients/{id}/config.json` | Client config incl. schedule, smartSchedule, blotato |
| `data/clients/{id}/leadgen/precision-briefs.json` | Content briefs |
| `data/clients/{id}/assets/precision/` | Locally generated images |

## Next Priorities
1. Advance current leads from stage 3 → DM (stage 5)
2. Add Google Maps source (no auth needed, high value)
3. Add LinkedIn source (interior designers UAE)
4. Lead feedback attribution → Claude insights on which sources convert best
