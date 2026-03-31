# Competitor Intelligence API — Spec for SocialPilot to Build

DrSleeepSocial (our posting/engagement engine on Railway) needs to pull competitor intelligence from your system. You already have the data — competitor profiles, IG scraping via browser automation, Meta Ads Library. We just need API endpoints to query it.

**Why:** We use this data to decide where Nada comments on Instagram. She comments on competitor posts with the highest engagement (most comments = most eyeballs = likely ad-boosted). We need the data filtered server-side so we only get high-value posts worth commenting on.

---

## Endpoints to Build

### 1. Full Competitor Intel

```
GET /api/external/competitor-intel
```

**Auth:** API key via header `X-API-Key: {COMPETITOR_INTEL_API_KEY}` (env var you set)

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `handles` | string | all | Comma-separated IG handles. If empty, return all tracked competitors |
| `from` | date | 30 days ago | Start date (ISO format, e.g. `2026-03-01`) |
| `to` | date | today | End date |
| `sort` | string | `comments` | Sort posts by: `comments`, `likes`, `recent` |
| `limit` | number | 10 | Max posts per competitor |
| `min_comments` | number | 10 | **Only return posts with at least this many comments** |
| `min_likes` | number | 50 | **Only return posts with at least this many likes** |
| `include` | string | all | Comma-separated: `profile,posts,ads,leads` |

**IMPORTANT: The `min_comments` and `min_likes` filters are critical.** Since you scrape via browser automation, you're already fetching all posts. Filter them BEFORE returning so we don't get 60 low-engagement posts. We only want the ones with real activity — those are the posts with paid traffic or viral reach, and the only ones worth commenting on.

**Response:**

```json
{
  "competitors": [
    {
      "handle": "togasofficial.mideast",
      "profile": {
        "name": "Togas",
        "followers": 12500,
        "category": "luxury_bedding",
        "price_tier": "luxury",
        "positioning": "Greek luxury, 5-star hotel quality",
        "strengths": ["Brand heritage", "Premium packaging"],
        "weaknesses": ["No bamboo products", "Limited UAE return policy"],
        "opportunity": "Their customers pay AED 800-2000 for cotton. Bamboo outperforms cotton in UAE heat.",
        "hunt_priority": "high"
      },
      "posts": [
        {
          "url": "https://www.instagram.com/p/ABC123/",
          "shortCode": "ABC123",
          "caption": "Our new hotel collection...",
          "likesCount": 450,
          "commentsCount": 87,
          "timestamp": "2026-03-15T10:00:00Z",
          "isSponsored": true,
          "hashtags": ["bedding", "luxury", "hotel"]
        }
      ],
      "activeAds": [
        {
          "adText": "Sleep like you're in a 5-star hotel every night",
          "product": "Hotel Collection Egyptian Cotton Sheets",
          "startDate": "2025-12-01",
          "daysRunning": 120,
          "format": "carousel",
          "link": "https://togas.com/...",
          "instagramUrl": "https://www.instagram.com/p/XYZ789/",
          "signal": "Hotel positioning — 120 days running = proven best seller"
        }
      ],
      "leadCount": 45
    }
  ],
  "meta": {
    "totalCompetitors": 11,
    "totalPosts": 34,
    "totalAds": 23,
    "filtersApplied": {
      "min_comments": 10,
      "min_likes": 50,
      "dateRange": "2026-03-01 to 2026-03-31"
    },
    "scannedAt": "2026-03-31T07:00:00Z"
  }
}
```

---

### 2. Top Posts (Lightweight — for hourly polling)

```
GET /api/external/competitor-top-posts
```

**Same auth.** This is what DrSleeepSocial calls every hour to decide where Nada should comment next. It must be fast and lightweight — just the posts, no profiles.

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sort` | string | `comments` | `comments`, `likes`, `engagement` (likes+comments) |
| `limit` | number | 20 | Max total posts returned |
| `from` | date | 14 days ago | Only posts newer than this |
| `min_comments` | number | 15 | **Minimum comments to qualify** |
| `min_likes` | number | 100 | **Minimum likes to qualify** |
| `exclude_handles` | string | none | Comma-separated handles to skip (posts we already commented on) |

**Response:**

```json
{
  "posts": [
    {
      "url": "https://www.instagram.com/p/ABC123/",
      "shortCode": "ABC123",
      "ownerUsername": "togasofficial.mideast",
      "competitorName": "Togas",
      "caption": "Our new hotel collection sheets are now available...",
      "likesCount": 450,
      "commentsCount": 87,
      "timestamp": "2026-03-15T10:00:00Z",
      "isSponsored": true
    },
    {
      "url": "https://www.instagram.com/p/DEF456/",
      "shortCode": "DEF456",
      "ownerUsername": "sleepycloud.ae",
      "competitorName": "Sleepy Cloud",
      "caption": "Summer is coming — are you ready for cooling comfort?",
      "likesCount": 230,
      "commentsCount": 54,
      "timestamp": "2026-03-20T14:00:00Z",
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

**Why the minimums matter:** If a competitor has 10 recent posts and 8 of them have <10 comments, those are dead posts nobody's reading. We only want the 2 posts where real conversations are happening. Commenting on a dead post is wasted effort. Commenting on a post with 87 comments means 87+ people (and all future visitors) see Nada's comment.

---

### 3. Webhook (Optional — for later)

If you want to push data instead of us polling:

```
POST https://drsleeepsocial-production.up.railway.app/api/listener/competitor-posts
```

Push new high-engagement posts (>50 comments) as they're discovered during your scrape runs. We'll use the same auth in reverse (we'll give you an API key).

---

## What We Do With This Data

1. **Hourly:** Call `/competitor-top-posts?sort=comments&min_comments=15&limit=20`
2. **Pick the #1 post** we haven't commented on yet
3. **AI generates a natural, helpful comment** as Nada (sleep science expert — never promotional)
4. **Post the comment** via Apify Instagram comment bot using Nada's session cookies
5. **Result:** Nada shows up in the comment section of competitor posts where high-intent buyers are actively engaging

We do max 4 comments/day, spread across hours, with 30-60s delays. All innocent/value-add — no brand mentions on 60% of comments.

---

## The 11 Competitors (Already in Your System)

| # | Name | IG Handle | Priority |
|---|------|-----------|----------|
| 1 | Togas | togasofficial.mideast | High |
| 2 | Linen Obsession | linenobsession | High |
| 3 | Chattels & More | chattelsandmore | Medium |
| 4 | Karaz Linen | karaz_linen | High |
| 5 | King Koil ME | kingkoilme | High |
| 6 | The Mattress Store | themattressstoreae | Medium |
| 7 | Sleepy Cloud | sleepycloud.ae | High |
| 8 | Blando | tryblando | Medium |
| 9 | Al Saad Home | alsaadhome | Medium |
| 10 | Reefi | reefi.me | Medium |
| 11 | Professor UAE | professoruae | Low |

---

## What We Need From You

1. The **base URL** of your API (e.g., `https://your-app.railway.app`)
2. The **API key value** for `COMPETITOR_INTEL_API_KEY`
3. Confirmation the endpoints are live

We'll set these as env vars on our Railway:
```
SOCIALPILOT_API_URL=https://your-app.railway.app
SOCIALPILOT_API_KEY=the-key-you-generate
```

Our server calls from: `https://drsleeepsocial-production.up.railway.app`
