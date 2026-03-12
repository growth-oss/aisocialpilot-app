# AI Social Pilot

> Self-hosted social media lead generation & automation platform.
> Powered by Claude AI + Playwright. Deployed on Railway.

---

## What It Does

- **Lead Generation** — Scrapes competitor followers, hashtag users, and location posts on Instagram. Scores each lead and builds a nurture pipeline.
- **Engagement Engine** — Claude runs automated engagement sessions: view stories → like posts → follow → comment → DM. Human-like timing, proxy-verified.
- **Precision Content Engine** — Clusters leads by pain point, generates content briefs (Claude), creates matching images (Gemini), queues posts for auto-publishing.
- **Smart Auto-Schedule** — Randomises run times daily within configurable GST windows. Fully hands-off once enabled.
- **Admin Panel** — Web UI to manage clients, monitor pipelines, review leads, and configure everything.

---

## Stack

| Layer | Tech |
|-------|------|
| Server | Node.js + Express |
| AI (automation) | Claude Sonnet via Anthropic API |
| AI (images) | Gemini `gemini-3.1-flash-image-preview` via `@google/genai` |
| Browser automation | Playwright (headed, Xvfb display) |
| Storage | JSON files in `data/` |
| Deploy | Railway (Docker, auto-deploy on push) |

---

## Admin Panel Tabs

### Overview
- KPI cards (total leads, hot leads, DMs sent, converted)
- Source health pills
- 🗓 **Auto-Schedule card** — enable/configure daily run windows (GST), shows today's run times and next run countdown
- Conversion funnel
- Recent runs

### Pipeline
- Full lead list with scores, stages, platform badges
- One-click stage advance, feedback buttons (good/bad/purchased)

### Content ✨
- Generate content briefs from lead clusters (Claude)
- Generate matching images (Gemini) with refinement prompts
- Approve → queue → auto-posts during next scheduled run
- Queue-based posting with human-like behaviour (browse-first, 15-40min gaps between briefs)

### Leads
- Searchable lead table, filters by score/stage/platform

### Runs
- Run history with full log viewer, live status during active runs

### Hunt
- Competitor audience scraping configuration

### Settings
- API keys (Anthropic, Gemini), proxy, brand voice, platform handles

---

## Setup (Railway)

1. Fork this repo
2. Create a Railway project → connect the repo
3. Set environment variables:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   GEMINI_API_KEY=AIza...        # for image generation
   SOCIALPILOT_PROXY=http://user:pass@host:port
   ADMIN_SECRET=your-admin-password
   ```
4. Railway auto-deploys on every push to `main`
5. Open the Railway URL, create your first client, log in browser sessions via VNC

---

## Auto-Schedule

Enable in the **Overview tab → 🗓 Auto-Schedule card**:

- Set 1–3 GST time windows (e.g. 08:00–10:00, 13:00–15:00, 19:00–21:00)
- Each day at midnight UTC, one random time is picked within each window
- Times are written to `client.schedule.leadgen` — the existing scheduler fires Claude at those exact times
- No action needed after enabling — runs happen automatically every day

---

## Key Files

```
server/
  index.js                    # Express server + all API endpoints + schedulers
  leadgen/
    prompt.js                 # Claude prompt (Phases A–D incl. content posting)
    db.js                     # Lead pipeline DB

admin/public/
  index.html                  # Global admin (client list, settings)
  client.html                 # Per-client dashboard

data/
  clients/{id}/
    config.json               # Client config + schedule + smartSchedule
    leadgen/
      leads.db                # SQLite lead pipeline
      precision-briefs.json   # Content briefs
    assets/precision/         # Generated images
    logs/                     # Run logs, scheduled.log

scripts/
  start.sh                    # Entrypoint (starts Xvfb + server)
```

---

## Architecture Notes

- **Scheduler** checks every 60s for times in `client.schedule.leadgen[]`
- **Smart schedule** generates UTC times from GST windows, writes to `schedule.leadgen`
- **PHASE D** in `prompt.js` — if briefs with `status: "queued"` exist, Claude posts them during the run with human-like timing
- **Proxy**: all browser launches use `SOCIALPILOT_PROXY` if set; geo verified via `curl ipinfo.io` before every session
- **Sessions**: each platform gets its own `browser-sessions/{platform}/` directory

---

## License

Proprietary — see LICENSE file.
