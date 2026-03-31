# Competitor Intelligence System — How It Works & How to Run It

## What This System Does

The **🕵️ Intel tab** on the client dashboard (`client.html?id=bamboo-sleep-professor`) shows:

1. **Competitor cards** — 11 UAE bedding/sleep competitors with positioning, strengths, weaknesses, opportunities
2. **Meta Ads Intelligence** — longest-running ads = best-selling products (manually researched + enriched by scrape runs)
3. **Live Content Feed** — posts and activity scraped from competitor Instagram accounts, pulled from the leads pipeline
4. **Opportunity Map** — strategic attack angles against each competitor cluster
5. **Content Pillar Playbook** — content gaps competitors leave open

---

## Where the Data Comes From

### 1. Competitor Profiles (Static + Editable)

**Storage:** `data/clients/{CLIENT_ID}/knowledge/competitors.json`

**API:**
- `GET /api/clients/:id/knowledge/competitors` — read all
- `PUT /api/clients/:id/knowledge/competitors` — full replace
- `POST /api/clients/:id/knowledge/:section` — upsert by name/instagram/website

**How seeded:** The dashboard auto-seeds 11 competitors via `CI_SEED_DATA` in `client.html` on first load if `competitors.json` is empty. Each competitor has:

```json
{
  "name": "Togas",
  "website": "https://togas.com/mideast/",
  "instagram": "@togasofficial.mideast",
  "category": "bedding",
  "price_tier": "luxury",
  "uae_presence": "yes",
  "positioning": "...",
  "key_products": ["..."],
  "strengths": ["..."],
  "weaknesses": ["..."],
  "content_angle": "...",
  "complaint_keywords": ["..."],
  "opportunity": "...",
  "ads_running": true,
  "hunt_priority": "high"
}
```

**To update a competitor:** PUT the full updated array to the knowledge API, or edit `competitors.json` directly on the Railway volume.

---

### 2. Meta Ads Intelligence — How to Get Real Data

The "Meta Ads Intelligence" panel currently shows **manually researched static data** (5 example ads). To get real live ad data:

#### Method A — Manual Meta Ads Library Search (Recommended)

1. Go to: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=AE&q=KEYWORD`
2. Search keywords: `bamboo sheets`, `bedding UAE`, `mattress`, `مرتبة`, `شراشف`, `linen UAE`
3. Filter by: **Country = AE**, **Status = Active**
4. For each competitor brand, search their name directly
5. Note: ads running longest (check "Started running on" date) = their best sellers
6. Copy: advertiser name, ad copy/headline, start date, media type (image/video/carousel)

#### Method B — Automated Scrape (Claude Automation Run)

The `leadgen` run already scrapes Meta Ads Library when `hot-sources.json` has entries with `type: "meta_ads"`. To add competitors:

```json
// In data/clients/bamboo-sleep-professor/leadgen/hot-sources.json — add entries like:
{
  "platform": "meta_ads",
  "type": "meta_ads",
  "handle_or_url": "bamboo sheets UAE",
  "enabled": true,
  "why": "Competitor ad monitoring — find hot products"
},
{
  "platform": "meta_ads",
  "type": "meta_ads",
  "handle_or_url": "Togas bedding",
  "enabled": true,
  "why": "Togas competitor ad monitoring"
}
```

When the `leadgen` command runs, Claude will:
1. Open Meta Ads Library in the browser (UAE filter)
2. Search for advertiser brand names
3. Extract brand names from the page
4. Search Instagram for those brands
5. Save findings to `hot-sources.json` and create leads from ad commenters

#### Updating the Ads Panel with Real Data

When you find real ads, update the `renderAdsIntel()` function in `client.html` OR (better) store them in `competitors.json` under each competitor's `active_ads` field:

```json
{
  "name": "Togas",
  "active_ads": [
    {
      "product": "Hotel Collection Egyptian Cotton Sheets",
      "copy": "Sleep like you're in a 5-star hotel",
      "days_running": 90,
      "started": "2025-12-01",
      "format": "carousel",
      "signal": "Hotel positioning — counter with bamboo cooling story"
    }
  ]
}
```

Then update `renderAdsIntel()` to read from `ciData` instead of the hardcoded array.

---

### 3. Live Content Feed — How It Works

**The live feed is NOT a real-time scraper.** It pulls from leads that were already scraped from competitor Instagram accounts during regular automation runs.

**How leads get into the feed:**

1. Each competitor's Instagram handle is in `hot-sources.json` as `type: "account"`
2. When `leadgen` runs, it scrapes their posts' commenters and likers
3. Those leads get saved to `leads.json` with `source_handle = "@competitor_handle"` and `source_type = "competitor_commenter"` or similar
4. The Intel tab reads leads from the pipeline API and filters by `source_type` matching competitor patterns

**To populate the feed:**

```
Run command: leadgen
OR
Run command: outreach
```

These runs scrape competitor accounts and create leads. The Intel tab then shows those leads as "recent activity from competitors."

**Competitor accounts that get scraped (from `hot-sources.json`):**
When competitors are seeded via `CI_SEED_DATA`, the server's `saveSection` handler automatically adds each competitor's Instagram handle to `hot-sources.json` as a monitored account. So simply seeding competitors auto-enables their account monitoring.

---

### 4. Running Competitor Intelligence Manually

From the Intel tab:

| Button | What it does |
|--------|-------------|
| **↻ Refresh** | Reloads all competitor data + lead counts |
| **🕵️ Run Intercept** | Opens competitor posts, finds pain-point conversations, posts natural comments to attract DMs |
| **🎯 Run Audience Hunt** | Scrapes commenters/likers from competitor posts, adds them to the lead pipeline |
| **🔍 Scan Meta Ads Library** | Runs `leadgen` which includes Meta Ads scraping if configured in hot-sources |

---

## For a New Claude Session — Step by Step

### Step 1: Check current competitor data

```
GET /api/clients/bamboo-sleep-professor/knowledge/competitors
```

If empty → the seed data will auto-populate on next Intel tab load.

### Step 2: Add competitor Instagram accounts to hot-sources

Read `data/clients/bamboo-sleep-professor/leadgen/hot-sources.json`.

If the competitor handles aren't there, they get added automatically when the dashboard seeds `competitors.json` (the server's PUT handler propagates them). If not, add them manually:

```json
{
  "platform": "instagram",
  "type": "account",
  "handle_or_url": "@togasofficial.mideast",
  "enabled": true,
  "why": "Competitor — monitor for audience interception"
}
```

### Step 3: Run outreach/intercept to scrape competitor audiences

Trigger the `outreach` or `intercept` command for the client. This:
- Opens each competitor's Instagram
- Scrapes post commenters who mention pain points (heat, sleep quality, etc.)
- Saves them as leads with `source_handle = competitor_handle`
- These appear in the Intel tab Live Content Feed

### Step 4: Update Meta Ads data

1. Manually search Meta Ads Library (https://www.facebook.com/ads/library/?country=AE) for each competitor
2. Note: ad start date, product being advertised, ad copy
3. Update `renderAdsIntel()` in `client.html` with real data
4. OR add `active_ads` array to each competitor in `competitors.json` and update the render function to read from it

### Step 5: Keep competitors.json updated

When a competitor launches a new product, changes positioning, or starts running new ads:
```
PUT /api/clients/bamboo-sleep-professor/knowledge/competitors
[...updated array...]
```

---

## Key Files

| File | Purpose |
|------|---------|
| `admin/public/client.html` | Intel tab UI — `CI_SEED_DATA`, `renderAdsIntel()`, `renderContentFeed()`, `renderContentPillars()` |
| `data/clients/bamboo-sleep-professor/knowledge/competitors.json` | Persistent competitor profiles (Railway volume) |
| `data/clients/bamboo-sleep-professor/leadgen/hot-sources.json` | Competitor accounts to monitor — auto-populated from competitors.json |
| `data/clients/bamboo-sleep-professor/leadgen/leads.json` | All scraped leads — Intel feed reads leads with competitor source_handles |
| `server/scripts/phase-b-pipeline.js` | Runs engagement on leads from competitor accounts |
| `server/index.js` — `saveSection('competitors')` | Auto-propagates competitor handles → hot-sources when competitors are saved |

## Current 11 Competitors (bamboo-sleep-professor)

| # | Name | IG Handle | Tier | Hunt Priority |
|---|------|-----------|------|---------------|
| 1 | Togas | @togasofficial.mideast | Luxury | High |
| 2 | Linen Obsession | @linenobsession | Mid | High |
| 3 | Chattels & More | @chattelsandmore | Mid | Medium |
| 4 | Karaz Linen | @karaz_linen | Premium | High |
| 5 | King Koil | @kingkoilusa | Premium | High |
| 6 | The Mattress Store | @themattressstoreae | Mid | Medium |
| 7 | Sleepy Cloud | @sleepycloud.ae | Mid | High |
| 8 | Blando | @tryblando | Mid | Medium |
| 9 | Al Saad Home | @alsaadhome | Luxury | Medium |
| 10 | Reefi | @reefi.me | Mid | Medium |
| 11 | Professor UAE | @professoruae | Mid | Low |

**Highest-value interception targets (hot leads):**
- Sleepy Cloud — audience already knows the UAE heat sleep problem
- Karaz Linen — Arabic-speaking audience, matches our ambassador's voice
- King Koil / Mattress Store — post-purchase buyers who need sheets
- Togas — premium buyers who can be converted with better value story
