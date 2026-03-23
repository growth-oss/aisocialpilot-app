# AI Social Pilot — Current Project State
**Last updated: 2026-03-23**

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
- **Pipeline: ~1,375 total leads** (65 active stages 3–6, 1,310 stage 0 discovery)
  - Stage 6 (reply received): 22 leads — have coupon codes, 0 converted yet
  - Stage 3 (followed): ~26 leads — primary DM targets
  - YouTube-only: ~1,267 leads — can't be DM'd on Instagram directly

## What's Working ✅
- Instagram lead gen (competitor scraping, hashtag, location) — UAE proxy, headed browser
- Lead pipeline with 8 stages (New → Converted)
- Admin dashboard with client management
- Client detail page (`/client.html`) — sidebar nav, Claude chat panel, lead feedback
- Run history with full log viewer + live run status
- Anthropic Messages API chat endpoint for client conversations
- Browser session management via VNC
- Scheduler (3 GST time windows per day, random times per window)
- License system
- **Blotato posting** (ACTIVE — replaces Playwright for all posts)
- **Precision Content Engine** (Content tab)
- **Smart Auto-Schedule** (3 GST windows, random times daily)
- **YouTube scraping** — keyword + channel commenters, 56+ new leads per run
- **YouTube commenting** — 8 visibility comments per run (no proxy needed)
- **Phase C coupon DMs** — 2 sent in last run (stage 6 leads, score ≥ 30)
- **Phase B pipeline DMs** — /direct/new/ fallback wired (fixed 2026-03-23, testing now)

## What's NOT Done Yet 🔧
| Source | Status | Notes |
|--------|--------|-------|
| Instagram DMs | ⚠ Testing | Phase B /direct/new/ fallback deployed + concurrent run guard added. Next clean run will confirm. |
| Meta Ads Library | ⚠ Partial | Use for brand discovery only, not post URL scraping |
| Google Maps | ✅ Script ready | `scrape-google-maps.js` — B2B: hotels, interior designers, etc. No login/proxy. Scores by category (hotel=50, interior design=40). Add `google_maps` sources to hot-sources.json to activate. |
| LinkedIn | 🔧 TODO | Interior designers + procurement UAE |
| Facebook Groups | ✅ Scripts ready | 4-script system: `facebook-group-join.js` → `facebook-group-monitor.js` → `facebook-group-engage.js` → `scrape-facebook.js`. To activate: (1) login FB session via VNC, (2) add `platform: "facebook", type: "keyword"` sources to hot-sources.json |
| TikTok | ✅ Script ready | `scrape-tiktok.js` — public scraping, no session. 4 sources active (EN+AR). Cross-matches to Instagram. |
| Dubizzle | 🔧 TODO | Furnished apartment listings |
| Pinterest | 🔧 TODO | Home decor board savers |
| YouTube → Instagram cross-match | ✅ Wired | `youtube-to-instagram.js` runs as step 6 in scheduled runs |
| YouTube comment replies | ✅ Wired | `youtube-reply.js` runs as step 3 in scheduled runs |
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
11. **Blotato posting is direct** — `spawnRun()` sets `directCmd` for Blotato briefs, bypassing Claude CLI entirely.
12. **image_url absolute URLs**: if `brief.image_url` starts with `https://`, passed directly to Blotato.
13. **Blotato account IDs**: stored as `blotato.accounts.{platform}` in config.json.
14. **lead score field**: use `total_score` not `lead_score` for threshold comparisons (both exist but total_score is authoritative).
15. **Score thresholds**: set to 30 (was 60/70 — leads score 30–55 in practice). Uses `??` not `||`.

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
- **Score thresholds always defaulting to 60**: `|| 60` in prompt.js treated 0 as falsy → replaced all 10 occurrences with `?? 30`
- **Phase B DMs 0 sent — profile Message button blocked**: Instagram overlay prevents click; fix: when button not visible OR click throws timeout → fall through to `/direct/new/` search fallback (commit 6adbacd, 2026-03-23)
- **Phase B browser context crash from concurrent runs**: Two simultaneous runs share same Instagram session dir → Chrome crashes. Fix: server rejects `POST /run` with 409 if run already active for client (commit 65f9f96, 2026-03-23)
- **Config PUT wiping all sections**: PUT `/api/clients/:id/leadgen/config` replaces entire file — always send complete config object, never just a subset

## Standalone Scripts (in `server/scripts/`)
| Script | Purpose | Key env vars |
|--------|---------|-------------|
| `phase-b-pipeline.js` | DMs + comments for stage 3–4 IG leads | SESSION_DIR, PROXY, BASE_URL, CLIENT_ID |
| `phase-c-coupons.js` | Coupon DMs to stage 6 leads | SESSION_DIR, PROXY, COUPONS (JSON), MIN_SCORE |
| `scrape-youtube.js` | YouTube commenter discovery → leads | LEADS_FILE, CLIENT_ID |
| `youtube-reply.js` | Reply to YouTube comments from discovered leads | GOOGLE_SESSION_DIR, LEADS_FILE |
| `youtube-to-instagram.js` | Cross-match YouTube handles to Instagram | BASE_URL, CLIENT_ID, SESSION_DIR (IG), PROXY |
| `post-via-blotato.js` | Post via Blotato REST API | BLOTATO_API_KEY, BLOTATO_ACCOUNT_ID, IMAGE_URL, CAPTION |
| `post-to-instagram.js` | Playwright post fallback (Blotato not configured) | SESSION_DIR, PROXY |
| `facebook-group-join.js` | Apply to join FB groups by keyword | FB_SESSION_DIR, FB_GROUPS_FILE, FB_JOIN_KEYWORDS, PROXY |
| `facebook-group-monitor.js` | Check pending FB group applications | FB_SESSION_DIR, FB_GROUPS_FILE, PROXY |
| `facebook-group-engage.js` | Reply to threads + ask questions in member groups | FB_SESSION_DIR, FB_GROUPS_FILE, LEADS_FILE, CLIENT_ID |
| `scrape-facebook.js` | Scrape leads from FB member groups | FB_SESSION_DIR, FB_GROUPS_FILE, LEADS_FILE, CLIENT_ID |
| `scrape-google-maps.js` | B2B leads from Google Maps (no login/proxy) | MAPS_SOURCES, LEADS_FILE, CLIENT_ID |

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
| `data/clients/{id}/leadgen/leadgen-config.json` | Pipeline thresholds (all at 30), cooldown=0 |
| `data/clients/{id}/leadgen/coupon-config.json` | Coupon codes + min score thresholds |
| `data/clients/{id}/assets/precision/` | Locally generated images |
| `data/clients/{id}/facebook-groups.json` | FB group membership tracker (join → monitor → engage) |

## Next Priorities
1. **Confirm Phase B DM fix works** — next clean scheduled run (no concurrent conflict now) should show `[phase-b] direct/new` in log and send DMs
2. **Get first sale** — 22 stage-6 leads have coupon codes but 0 converted; try different coupon message angles
3. **Activate Google Maps** — add `{ platform: "google_maps", type: "keyword", handle_or_url: "hotel Dubai", enabled: true }` sources to hot-sources.json → runs automatically next session
4. **Activate Facebook Groups** — (a) login FB session via VNC, (b) add `{ platform: "facebook", type: "keyword", ... }` sources to hot-sources.json → join script runs automatically
5. **TikTok cross-match** — monitor next run for YouTube/TikTok → Instagram matches
