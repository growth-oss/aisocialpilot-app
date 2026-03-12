# AI Social Pilot — Current Project State
**Last updated: 2026-03-11**

> Read this at the start of any new session to understand where we are.
> For full technical details: `.claude/MEMORY.md`
> For automation run rules: `.claude/CLAUDE.md`

---

## What This Is
A self-hosted social media automation + lead generation platform.
- Admin panel: `admin/public/index.html` (all clients) + `admin/public/client.html` (per-client detail)
- Server: `server/index.js` (Express, ~3900 lines)
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
- Run history with full log viewer
- Anthropic Messages API chat endpoint for client conversations
- Browser session management via VNC
- Scheduler (per-platform UTC times)
- License system

## What's NOT Done Yet 🔧 (add sources one by one)
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
| YouTube | 🔧 TODO | Sleep/wellness video commenters |
| Quora | 🔧 TODO | Sleep quality question askers |

## Architecture Gotchas (read before coding)
1. **Geo check**: use `curl -s -x "$PROXY" --max-time 20 https://ipinfo.io/json` — NOT browser/whatismyip
2. **Session dirs**: `browser-sessions/{platform}/` — NOT `sessions/{platform}/`
3. **Cooldown JS**: use `??` not `||` (zero is falsy in JS)
4. **Meta Ads Library**: React SPA — extract brand names → find their Instagram → scrape posts
5. **Claude runs as `claude_runner` user** (not root) via `su -s /bin/bash claude_runner`
6. **client.html** is served as static file (express.static), does NOT need a server route

## Key Bugs Fixed (do NOT revert)
- Geo check timeout: 20s not 10s, curl not browser
- Cooldown `??` operator
- Session dir path: browser-sessions not sessions
- Run log capture: each run writes to `logs/runs/{runId}.log`
- getAuthHeaders removed from run log modal fetch

## Next Priorities
1. Advance current 36 leads from stage 3 → DM (stage 5)
2. Add Google Maps source (no auth needed, high value)
3. Add LinkedIn source (interior designers UAE)
4. Lead feedback attribution → Claude insights on which sources convert best

## Starting a New Source Session
Tell Claude: "I want to add [platform] as a lead gen source"
Claude should:
1. Read `.claude/CLAUDE.md` per-source quick reference
2. Add source config to `leadgen/hot-sources.json`
3. Update `server/leadgen/prompt.js` if platform needs specific scraping instructions
4. Set up session login if required (browser-sessions/{platform}/)
5. Test with a single run, review results in `/client.html`
