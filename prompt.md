# AI Social Pilot — Session Starter Prompt

Copy everything below this line and paste it at the start of a new Claude Code session.

---

## Context

You are working on **AI Social Pilot** — a multi-client social media automation platform.

**Live app**: https://aisocialpilot-app-production.up.railway.app/
**License server**: https://license.aisocialpilot.com
**Repo**: `growth-oss/aisocialpilot-app` (GitHub, auto-deploys to Railway on push to main)
**Status**: Live, Pro license, 1+ active clients

## Architecture

Single Docker container on Railway running:
- **Express server** (`server/index.js` ~3500 lines) — all API routes, automation engine, scheduler
- **Admin panel** (`admin/public/index.html` ~5000 lines) — single-file SPA
- **Playwright** (headed, `headless: false`) on Xvfb display `:99` — VNC at `/vnc/`
- **Claude CLI** spawned as `claude_runner` user for automation runs
- **Data volume** at `/app/data` — client configs, sessions, logs, knowledge base

## Key Files

| File | What |
|------|------|
| `server/index.js` | Main server — ALL routes, automation, scheduler |
| `server/leadgen/prompt.js` | Lead gen prompt builder (ambassador vs direct modes) |
| `server/leadgen/db.js` | Lead/source/log data store (JSON files) |
| `server/leadgen/templates/` | Default configs seeded per new client |
| `server/backup.js` | Backup module (tar+AES+R2) |
| `admin/public/index.html` | Admin panel SPA |
| `templates/escalation-rules.md` | Conversion funnel stages 0-6 + escalation rules |
| `templates/reply-templates.md` | Reply inspiration for all scenarios |
| `.claude/CLAUDE.md` | Instructions for Claude autonomous runs on Railway |
| `Dockerfile` | Docker build (Playwright base image) |
| `scripts/start.sh` | Startup: Xvfb → VNC → noVNC → Node |

## Per-Client Data (on Railway volume)

```
data/clients/{clientId}/
├── client.json              — name, platforms, proxy, schedule
├── config/brand-voice.md    — brand tone + rules
├── knowledge/               — products.json, competitors.json, keywords.json
├── leadgen/                 — leads.json, outreach-log.ndjson, leadgen-config.json,
│                              personas.json, coupon-config.json, hot-sources.json
├── intercept/               — intercept-config.json, intercept-log.ndjson
├── sessions/{platform}/     — Playwright browser sessions (cookies)
└── logs/                    — runs.json, screenshots/
```

## Lead Gen System

Two approach modes per client (set in `leadgen-config.json`):

**`"approach": "ambassador"`** — Client is an influencer/expert persona promoting indirectly
- Never mentions brand in public comments
- Engages competitor followers with genuine expertise
- Only reveals brand connection in private DMs after trust is built
- Coupons framed as "I have a code from the brand I work with"

**`"approach": "direct"`** — Client is the brand's own account
- Can mention products and brand in comments/DMs
- Still conversational and genuine, not corporate
- Coupons framed as "Here's a special code for you"

The 6-step engagement ladder: Story View → Like → Follow → Comment → Reply to Q → DM

## Active Clients

### Bamboo Sleep Professor (`bamboo-sleep-professor`)
- **Approach**: ambassador
- **Persona**: Nada Ali (بروفسور نوم البامبو) — sleep science expert
- **Brand promoted**: DrSleeep (drsleeep.ae) — bamboo bedding, pillows, sleep products
- **Ambassador site**: bamboosleepprofessor.com
- **Competitors**: @togasofficial.mideast (Togas), @linenobsession (Linen Obsession)
- **Coupons**: MyFriends20 (20%, score 60+), MyCode30 (30%, score 70+), My50VIP (50%, score 85+ — needs human approval)
- **WhatsApp**: wa.me/971544445476
- **Platforms**: Instagram, TikTok

## Key API Routes

```
GET  /api/status                         — health + license
GET  /api/clients                        — list all clients
POST /api/clients/:id/run               — start automation (SSE)
GET  /api/clients/:id/knowledge/:section — products, competitors, keywords
PUT  /api/clients/:id/leadgen/config    — update leadgen config/personas/coupons/sources
GET  /api/clients/:id/leadgen/stats     — pipeline stats
GET  /api/clients/:id/leadgen/leads     — lead list with filters
PUT  /api/clients/:id/intercept/config  — update intercept settings
POST /api/clients/:id/intel/run         — start AI research job
```

## Important Notes

- Root directory is clean — no duplicate config files. All client data lives on Railway volume.
- Templates in `server/leadgen/templates/` are generic defaults — they seed on first client access.
- Client-specific data is managed via admin panel or API, never hardcoded in templates.
- The `.claude/CLAUDE.md` is for autonomous Claude runs ON Railway, not for your coding sessions.
- Memory file at `.claude/projects/.../memory/MEMORY.md` has the full project history.
- Always read memory file first: it's the source of truth for what's built and what's current.

## MANDATORY: Keep Docs In Sync With Every Commit

**This is a hard rule.** Whenever you commit code changes, you MUST also update the relevant docs in the same commit (or an immediate follow-up). Stale docs cause confusion across sessions.

### Files to keep in sync:

| File | When to update |
|------|---------------|
| `prompt.md` (this file) | New client added, new feature/system built, architecture changed, new API routes, key file added/removed/moved |
| `.claude/projects/.../memory/MEMORY.md` | Same as above — this is the persistent memory across sessions |
| `templates/escalation-rules.md` | Conversion funnel changed, new escalation triggers, coupon tiers changed |
| `templates/reply-templates.md` | New reply patterns, new engagement scenarios |
| `.claude/CLAUDE.md` | Automation behavior changed, new run commands, browser/proxy logic changed |

### Specifically:

1. **New client added** → Add to "Active Clients" section in both `prompt.md` and `MEMORY.md`
2. **New API route** → Add to "Key API Routes" in `prompt.md` and `MEMORY.md`
3. **New feature/system** → Add to "Core Features Built" in `MEMORY.md`, update "Key Files" table in `prompt.md`
4. **File moved/renamed/deleted** → Update "Key Files" and project structure in both files
5. **Lead gen changes** → Update "Lead Gen System" section in `prompt.md`
6. **New coupon codes or tiers** → Update both the client section in `prompt.md` AND `templates/escalation-rules.md`
7. **Approach logic changed** → Update `prompt.md` Lead Gen section + `templates/escalation-rules.md`

### How to check:

Before every commit, ask yourself:
- "Would a new Claude session understand what I just changed without reading the code?"
- If no → update the docs.

## What to do first

1. Read the memory file (it loads automatically if configured)
2. Check `git log --oneline -10` for recent changes
3. Check `/api/status` if you need to verify the live app
4. Ask the user what they want to work on
