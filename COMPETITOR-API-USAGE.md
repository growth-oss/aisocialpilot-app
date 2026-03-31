# Competitor Intelligence API — Integration Guide

Base URL: `https://aisocialpilot-app-production.up.railway.app`

---

## Setup (One Time)

### 1. Generate an API key

Pick any strong random string, e.g.:
```
openssl rand -hex 32
→ a3f8c2e1d4b7a9f6e2c5d8b1a4f7c0e3d6b9a2f5c8e1d4b7a0f3c6e9d2b5a8f1
```

### 2. Set env vars on Railway

**On `aisocialpilot-app` (this server):**
```
COMPETITOR_INTEL_API_KEY=<your-key>
```

**On `drsleeepsocial` (the calling server):**
```
SOCIALPILOT_API_URL=https://aisocialpilot-app-production.up.railway.app
SOCIALPILOT_API_KEY=<same-key>
```

### 3. Verify it works

```bash
curl -H "X-API-Key: <your-key>" \
  "https://aisocialpilot-app-production.up.railway.app/api/external/competitor-top-posts?limit=5"
```

Expected response when post data exists:
```json
{
  "posts": [...],
  "meta": { "totalBeforeFilter": 120, "totalAfterFilter": 5, ... }
}
```

Expected response when scraper hasn't run yet (empty but valid):
```json
{ "posts": [], "meta": { "totalBeforeFilter": 0, "totalAfterFilter": 0, ... } }
```

---

## When Does Post Data Get Populated?

The scraper `scrape-competitor-posts.js` runs automatically every day at **06:30 UTC** as part of the pipeline autopilot (requires `client.schedule.leadgen` to be set, which it is for `bamboo-sleep-professor`).

It visits each of the 11 competitor Instagram profiles, scrapes their last 12 posts, and saves to:
```
/data/clients/bamboo-sleep-professor/leadgen/competitor-posts.json
```

You can also trigger it manually from the admin dashboard:
→ Client page → Runs tab → Run Now → type `scrape-competitor-posts`

---

## Endpoint 1 — Top Posts (Hourly Poll)

```
GET /api/external/competitor-top-posts
X-API-Key: <your-key>
```

**Use this for:** deciding which competitor post Nada should comment on next.

### Query Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `sort` | `comments` | `comments` / `likes` / `engagement` (likes+comments) / `recent` |
| `limit` | `20` | Max posts returned (hard cap: 100) |
| `from` | 14 days ago | Only posts newer than this date (ISO format: `2026-03-01`) |
| `min_comments` | `15` | **Skip posts with fewer comments than this** |
| `min_likes` | `100` | **Skip posts with fewer likes than this** |
| `exclude_handles` | — | Comma-separated handles to skip (posts you already commented on) |

### Example — Hourly poll for best posts to comment on

```bash
curl -H "X-API-Key: <key>" \
  "BASE_URL/api/external/competitor-top-posts\
?sort=comments\
&min_comments=15\
&min_likes=100\
&limit=20\
&exclude_handles=togasofficial.mideast,sleepycloud.ae"
```

### Response

```json
{
  "posts": [
    {
      "url": "https://www.instagram.com/p/ABC123/",
      "shortCode": "ABC123",
      "ownerUsername": "karaz_linen",
      "competitorName": "Karaz Linen",
      "caption": "Our new 600TC luxury duvet set is here...",
      "likesCount": 620,
      "commentsCount": 143,
      "timestamp": "2026-03-28T09:00:00Z",
      "isSponsored": true
    },
    {
      "url": "https://www.instagram.com/p/DEF456/",
      "shortCode": "DEF456",
      "ownerUsername": "sleepycloud.ae",
      "competitorName": "Sleepy Cloud",
      "caption": "Summer is here — is your pillow keeping you cool?",
      "likesCount": 312,
      "commentsCount": 89,
      "timestamp": "2026-03-29T11:30:00Z",
      "isSponsored": false
    }
  ],
  "meta": {
    "totalBeforeFilter": 156,
    "totalAfterFilter": 20,
    "filtersApplied": {
      "min_comments": 15,
      "min_likes": 100,
      "from": "2026-03-17"
    }
  }
}
```

### Recommended usage pattern (DrSleeepSocial)

```javascript
// Every hour:
const res = await fetch(`${SOCIALPILOT_API_URL}/api/external/competitor-top-posts` +
  `?sort=comments&min_comments=15&min_likes=100&limit=20` +
  `&exclude_handles=${alreadyCommentedHandles.join(',')}`,
  { headers: { 'X-API-Key': SOCIALPILOT_API_KEY } }
);
const { posts } = await res.json();
if (!posts.length) return; // nothing qualifying today

// Pick the top post not already commented on
const target = posts.find(p => !alreadyCommentedUrls.has(p.url));
if (!target) return;

// Generate comment + post via Apify
await commentOnPost(target.url, generateComment(target.caption, target.competitorName));
alreadyCommentedUrls.add(target.url);
```

---

## Endpoint 2 — Full Intel (On Demand)

```
GET /api/external/competitor-intel
X-API-Key: <your-key>
```

**Use this for:** dashboard views, strategy planning, building competitor reports.

### Query Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `handles` | all | Comma-separated handles to filter (e.g. `karaz_linen,sleepycloud.ae`) |
| `from` | 30 days ago | Start date for posts |
| `to` | today | End date for posts |
| `sort` | `comments` | Same sort options as above |
| `limit` | `10` | Max posts **per competitor** |
| `min_comments` | `10` | Min comments to include a post |
| `min_likes` | `50` | Min likes to include a post |
| `include` | `all` | Comma-separated: `profile,posts,ads,leads` — omit sections you don\'t need |

### Example — Get top 5 posts from high-priority competitors only

```bash
curl -H "X-API-Key: <key>" \
  "BASE_URL/api/external/competitor-intel\
?handles=karaz_linen,togasofficial.mideast,sleepycloud.ae\
&sort=comments\
&min_comments=20\
&limit=5\
&include=profile,posts"
```

### Example — Get only profiles (no posts, fast)

```bash
curl -H "X-API-Key: <key>" \
  "BASE_URL/api/external/competitor-intel?include=profile,leads"
```

### Response

```json
{
  "competitors": [
    {
      "handle": "karaz_linen",
      "clientId": "bamboo-sleep-professor",
      "profile": {
        "name": "Karaz Linen",
        "followers": null,
        "category": "bedding",
        "price_tier": "premium",
        "positioning": "Jordanian luxury linen with strong pan-Arab following...",
        "strengths": ["Strong Arabic-speaking audience", "Pan-Arab brand trust"],
        "weaknesses": ["Thread count is a marketing myth", "Cotton performs poorly in UAE heat"],
        "opportunity": "Karaz Arabic-speaking audience is our most valuable target...",
        "hunt_priority": "high",
        "uae_presence": "yes",
        "website": "https://karazlinen.com/en/"
      },
      "posts": [
        {
          "url": "https://www.instagram.com/p/ABC123/",
          "shortCode": "ABC123",
          "ownerUsername": "karaz_linen",
          "competitorName": "Karaz Linen",
          "caption": "Our new luxury collection...",
          "likesCount": 620,
          "commentsCount": 143,
          "timestamp": "2026-03-28T09:00:00Z",
          "isSponsored": true,
          "hashtags": ["luxury", "bedding", "uae"],
          "scrapedAt": "2026-03-31T06:35:00Z"
        }
      ],
      "activeAds": [],
      "leadCount": 28
    }
  ],
  "meta": {
    "totalCompetitors": 3,
    "totalPosts": 15,
    "totalAds": 0,
    "filtersApplied": {
      "min_comments": 20,
      "min_likes": 50,
      "dateRange": "2026-03-01 to 2026-03-31"
    },
    "scannedAt": "2026-03-31T10:00:00Z"
  }
}
```

---

## Adding Competitor Ad Data

The `activeAds` array is populated from each competitor\'s record in `competitors.json`. To add real ad data after checking Meta Ads Library:

### Via API (recommended)

```bash
# Get current competitors
curl -H "X-API-Key: <key>" \
  "BASE_URL/api/external/competitor-intel?include=profile" \
  | jq '.competitors[] | select(.handle == "togasofficial.mideast")'

# Update via knowledge API (internal auth — from admin UI or Railway shell):
curl -X PUT https://BASE_URL/api/clients/bamboo-sleep-professor/knowledge/competitors \
  -H "Content-Type: application/json" \
  -d '[
    {
      "name": "Togas",
      "instagram": "@togasofficial.mideast",
      "active_ads": [
        {
          "product": "Hotel Collection Egyptian Cotton Sheets",
          "copy": "Sleep like you\'re in a 5-star hotel every night",
          "startDate": "2025-12-01",
          "daysRunning": 120,
          "format": "carousel",
          "signal": "120 days running = their best seller. Counter: bamboo feels softer AND cooler."
        }
      ]
    }
  ]'
```

### Via Admin UI

Intel tab → competitor card → manually update via the Settings → Knowledge → Competitors editor.

---

## The 11 Tracked Competitors

| Handle | Name | Priority | Category |
|--------|------|----------|----------|
| `togasofficial.mideast` | Togas | High | Luxury bedding |
| `linenobsession` | Linen Obsession | High | Mid bedding |
| `karaz_linen` | Karaz Linen | High | Premium bedding |
| `kingkoilusa` | King Koil | High | Premium mattress |
| `sleepycloud.ae` | Sleepy Cloud | High | Mid sleep |
| `chattelsandmore` | Chattels & More | Medium | Home decor |
| `themattressstoreae` | The Mattress Store | Medium | Mid mattress |
| `tryblando` | Blando | Medium | Mid mattress |
| `alsaadhome` | Al Saad Home | Medium | Luxury home |
| `reefi.me` | Reefi | Medium | Mid sleep |
| `professoruae` | Professor UAE | Low | Sleep |

---

## Error Responses

| Status | Meaning | Fix |
|--------|---------|-----|
| `401` | Wrong or missing `X-API-Key` header | Check the key matches `COMPETITOR_INTEL_API_KEY` on server |
| `503` | `COMPETITOR_INTEL_API_KEY` not set on server | Add env var to Railway and redeploy |
| `200` with empty `posts: []` | Scraper hasn\'t run yet or no posts meet filter thresholds | Lower `min_comments`/`min_likes`, or trigger `scrape-competitor-posts` run manually |

---

## Rate Limits & Notes

- No rate limit on the API endpoints themselves — call as often as needed
- The **scraper** runs once daily (06:30 UTC) — post data is refreshed every 24h
- Posts older than 30 days are automatically dropped from the cache
- `isSponsored: true` = post has "Paid Partnership" or "Sponsored" label — these are boosted posts with paid traffic, highest value for commenting
- `commentsCount` and `likesCount` are scraped from the post page — Instagram sometimes hides exact like counts; if `likesCount: 0` that doesn\'t mean zero likes, it means Instagram hid the count
