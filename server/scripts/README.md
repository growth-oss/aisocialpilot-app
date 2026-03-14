# Platform Scripts — Static Automation Scripts

## The Problem This Solves

When Claude runs a posting/automation task, the naive approach is to ask Claude to
*write* the Playwright script inside the run. This is bad:

- Wastes 30–60s and significant tokens just writing boilerplate
- Claude may write slightly different selector logic each run → inconsistent
- Bugs discovered in one run don't get fixed for the next
- Hard to test or audit the logic

## The Pattern

All repetitive browser automation (posting, DMs, scraping known sites) lives in
**static, version-controlled scripts** in this directory.

Claude's run prompt becomes:
1. Do the geo check
2. `node /app/server/scripts/post-to-instagram.js`
3. Report the output

All run-specific data (brief content, image paths, lead list, account credentials)
is injected as **environment variables** by the server before spawning Claude.

The scripts are standalone Node.js files — they can be tested locally, run
independently, and improved without changing the prompt.

---

## Scripts

### `post-to-instagram.js` ✅ DONE

Posts a precision brief to Instagram. Handles:
- Proxy geo check (via curl)
- Session login verification
- Feed warmup scroll
- Single image upload (local file) or multi-image carousel (CDN URL download → upload)
- Caption typing
- Share button
- Post URL verification from own profile grid
- DMs to eligible leads
- Brief status update in precision-briefs.json
- Error screenshots

**Env vars:**
| Var | Required | Description |
|-----|----------|-------------|
| `SESSION_DIR` | ✅ | Path to browser session dir |
| `INSTAGRAM_HANDLE` | ✅ | Account handle (without @) |
| `BRIEF_ID` | ✅ | Brief identifier |
| `BRIEFS_FILE` | ✅ | Absolute path to precision-briefs.json |
| `FORMAT` | ✅ | carousel \| post \| story \| dm_only |
| `PROXY_URL` | — | http://user:pass@host:port |
| `EXPECTED_GEO` | — | Country code to verify (e.g. AE) |
| `BRIEF_TYPE` | — | product_carousel \| standard |
| `CAPTION` | — | Post caption text |
| `IMAGE_PATH` | — | Absolute path to local image (standard briefs) |
| `CAROUSEL_IMAGES` | — | JSON array of CDN image URLs (product_carousel) |
| `SCREENSHOTS_DIR` | — | Where to save screenshots |
| `DM_LEADS` | — | JSON array of `{username, message}` |
| `LEADS_FILE` | — | Path to leads.json (for stage updates after DM) |
| `OUTREACH_LOG` | — | Path to outreach-log.ndjson |

---

### `post-to-tiktok.js` 🔧 TODO

Same pattern as Instagram. Posts a video or image to TikTok.

**Env vars to add:**
- `SESSION_DIR` — `browser-sessions/tiktok/`
- `TIKTOK_HANDLE`
- `VIDEO_PATH` or `IMAGE_PATH`
- `CAPTION`
- `BRIEF_ID`, `BRIEFS_FILE`
- `PROXY_URL`, `EXPECTED_GEO`

**Known TikTok DOM notes:**
- TikTok heavily rate-limits automation — use long delays (30–60s between actions)
- Upload button: `input[type="file"]` hidden, use `setInputFiles()` directly
- Caption: `div[contenteditable="true"]` in the upload form
- TikTok may show CAPTCHA on first upload — abort and flag for manual if so
- Session dir: `browser-sessions/tiktok/`

---

### `post-to-twitter.js` 🔧 TODO

Posts a tweet/thread with optional image to X (Twitter).

**Env vars to add:**
- `SESSION_DIR` — `browser-sessions/twitter/`
- `TWITTER_HANDLE`
- `TWEET_TEXT`
- `IMAGE_PATH` (optional)
- `BRIEF_ID`, `BRIEFS_FILE`
- `PROXY_URL`, `EXPECTED_GEO`

**Known Twitter/X DOM notes:**
- Compose box: `div[data-testid="tweetTextarea_0"]`
- Image upload: `input[data-testid="fileInput"]`
- Post button: `div[data-testid="tweetButtonInline"]`
- No proxy required for UAE market (Twitter not blocked in UAE)
- Rate limit: max 50 tweets/day, 20/hour

---

### `scrape-youtube.js` ✅ DONE

Scrapes YouTube video commenters for lead discovery. Handles:
- No-proxy browser launch (social media proxy blocks YouTube)
- Google session reuse for cookies
- Keyword search → video results → comment extraction
- Channel → videos tab → comment extraction
- Purchase signal detection (English + Arabic)
- UAE/Gulf geo mention detection
- Deduplication against existing leads
- Direct writes to leads.json + outreach-log.ndjson

**Env vars:**
| Var | Required | Description |
|-----|----------|-------------|
| `GOOGLE_SESSION_DIR` | ✅ | Path to Google browser session dir |
| `LEADS_FILE` | ✅ | Absolute path to leads.json |
| `SOURCES` | ✅ | JSON array of `{type, handle_or_url, why}` |
| `CLIENT_ID` | ✅ | Client identifier |
| `MAX_VIDEOS_PER_SOURCE` | — | Max videos per source (default: 10) |
| `MAX_COMMENTERS_PER_VIDEO` | — | Max commenters per video (default: 30) |
| `MAX_LEADS_PER_SOURCE` | — | Stop after N leads per source (default: 100) |
| `SCREENSHOTS_DIR` | — | Where to save screenshots |
| `OUTREACH_LOG` | — | Path to outreach-log.ndjson |
| `SCORE_VIDEO_COMMENTER` | — | Base score for keyword commenters (default: 25) |
| `SCORE_CHANNEL_COMMENTER` | — | Base score for channel commenters (default: 30) |
| `SCORE_PURCHASE_SIGNAL` | — | Bonus for purchase intent (default: 15) |
| `SCORE_GEO_BONUS` | — | Bonus for UAE mentions (default: 15) |

---

### `scrape-google-maps.js` 🔧 TODO

Scrapes business listings from Google Maps by keyword + location.

**Env vars to add:**
- `KEYWORD` — e.g. "luxury hotel Dubai"
- `LOCATION` — e.g. "Dubai, UAE"
- `MAX_RESULTS` — default 20
- `LEADS_FILE` — path to leads.json to append to
- `CLIENT_ID`

**Known Google Maps DOM notes:**
- No session/proxy needed (public content)
- Listings panel: `div[role="feed"]` → `a[href*="maps/place"]`
- Business name: `h1.DUwDvf` or `span.fontHeadlineLarge`
- Rating/reviews visible without login
- Scroll the feed panel to load more results (not the page)
- Use `DATA_DIR` env var set by the server for output paths

---

### `scrape-dubizzle.js` 🔧 TODO

Scrapes furnished rental listings from Dubizzle to find home furnishing buyers.

**Env vars to add:**
- `SEARCH_URL` — e.g. `https://dubizzle.com/for-rent/properties/?furnished=true`
- `MAX_PAGES` — default 3
- `LEADS_FILE`
- `CLIENT_ID`

**Known Dubizzle DOM notes:**
- No session/login needed (public)
- Listing cards: `article[data-testid]` or `div.listing-card`
- Poster name visible on listing detail page
- Phone numbers hidden behind "Show number" — don't click (ToS)
- Add score +30 for hotel/resort listings, +20 for villa/apartment furnished

---

### `send-dms-instagram.js` 🔧 TODO

Standalone DM sender (used outside of posting flow — e.g. follow-up DMs).

**Env vars to add:**
- `SESSION_DIR`
- `INSTAGRAM_HANDLE`
- `DM_LEADS` — JSON array of `{username, message}`
- `LEADS_FILE`
- `OUTREACH_LOG`
- `PROXY_URL`, `EXPECTED_GEO`
- `DAILY_DM_LIMIT` — default 15

---

## How the Server Injects Env Vars

In `server/index.js`, the `spawnRun()` function builds a shell script that exports
env vars before running Claude. For `precision-post:*` commands, it reads the brief
and leads files and adds script-specific vars to this shell script:

```javascript
// In spawnRun(), when command.startsWith('precision-post:'):
extraEnvExports = [
  `export SESSION_DIR='...'`,
  `export INSTAGRAM_HANDLE='...'`,
  `export BRIEF_ID='...'`,
  `export CAPTION='...'`,
  `export CAROUSEL_IMAGES='[...]'`,
  // etc.
];
// These are prepended to the shell script before the claude command
```

Claude's prompt then simply says:
```
Run: node /app/server/scripts/post-to-instagram.js
All config is already in your environment. Report the output when done.
```

## Adding a New Platform Script

1. Copy `post-to-instagram.js` as a starting point
2. Change the env var names to match the platform
3. Add the env var injection to `spawnRun()` in `server/index.js`
4. Update the prompt in `buildPrompt()` to reference the new script
5. Update this README with the new script's env vars and DOM notes
6. Test locally with `node server/scripts/your-script.js` with env vars set
