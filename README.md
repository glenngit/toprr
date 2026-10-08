# toprr — Top 10 Streaming Feed

A deployable TypeScript app that fetches the daily **Top 10 movies and TV shows**
from your chosen streaming services (Apple TV, Netflix, Amazon Prime Video,
HBO Max and more) using the
[Streaming Availability API](https://www.movieofthenight.com/about/api),
deduplicates them into a single feeding list, and feeds genuinely new titles to
**Overseerr / Jellyseerr** — never re-requesting anything already in your
library.

It ships with a **web GUI** (default port **9797**) to configure everything
(API keys, country, services), run syncs, and watch request status pulled live
from **Radarr** and **Sonarr**. It also works headless via CLI for a daily cron.

Output is **text-only** (no images). The feed function is importable so other
services can pull the latest list directly.

## How it works

- Uses the official [`streaming-availability`](https://github.com/movieofthenight/ts-streaming-availability)
  TypeScript client.
- Calls the **Get Top Shows** endpoint (`client.showsApi.getTopShows`) **once per
  service**. A single unfiltered call returns both movies and series (ordered by
  rank), which we split client-side — so the run uses **4 API calls total**, not
  8. Top lists are determined by each streaming service itself and refreshed
  **daily** by the API.
- Services tracked (API service codes):
  | Service              | Code      |
  | -------------------- | --------- |
  | Apple TV             | `apple`   |
  | Netflix              | `netflix` |
  | Amazon Prime Video   | `prime`   |
  | HBO Max (Max)        | `hbo`     |

> Note: for some service/type combinations the API returns fewer than 10 titles.
> The feed includes whatever the API provides, up to 10.

### API usage

Each run makes **4 calls** (one per service). Running once a day is
**~120 calls/month** — well within the free 1000/month quota.

## Setup

Requires Node.js 18+ (tested on Node 22).

```bash
npm install
cp .env.example .env   # then edit .env and set your key
```

### Authentication

The API authenticates via an **`X-API-Key`** request header, which the client
sends automatically from the key you provide. See the
[Authentication guide](https://docs.movieofthenight.com/guide/authentication).

Set your key in `.env`:

```
STREAMING_AVAILABILITY_API_KEY=your-api-key-here
FEED_COUNTRY=us
```

`.env` is git-ignored so your key is never committed. **Keep this server-side** —
using the key in a browser would expose it publicly.

## Usage

```bash
# Text output (default)
npm run feed

# JSON output — ideal for piping into other services
npm run feed:json

# Deduplicated "final feeding list" across all services (text / JSON)
npm run feed:list
npm run feed:list:json

# Seerr sync — DRY RUN: show which new titles WOULD be requested
npm run sync

# Seerr sync — actually submit requests for new titles
npm run sync:submit

# Compiled build
npm run build
npm start
```

### Seerr integration (Overseerr / Jellyseerr)

`sync` builds the deduplicated feed, then for each title checks your Seerr
instance and **skips anything that already exists or has already been
requested** (library status pending/processing/partially-available/available,
or an existing request). Only genuinely new titles are requested.

- **IDs**: requests use the numeric TMDB id (parsed from the Streaming
  Availability API's `movie/…` / `tv/…` form) routed by media type —
  movies to Radarr, TV to Sonarr.
- **Quality profile & root folder**: not overridden — Seerr applies each
  default server's defaults (e.g. Sonarr `HD - 720p/1080p` → `/media/TV6`,
  Radarr `HD-1080p` → `/media/Movies6`).
- **TV seasons**: in the GUI you choose seasons **per show** — the default is
  **Season 1 only** (so an old multi-season show in the Top 10 doesn't pull
  every season), with one-click **All**, **S1 only**, or a per-season checkbox
  picker (e.g. seasons 2–4 of 8). The headless CLI defaults to **season 1**.
  The requested seasons are recorded in the history.
- `sync` is a **dry run** by default; `sync:submit` is required to actually
  submit. This makes the automated once-a-day run safe to review first.

Requires `SEERR_URL` and `SEERR_API_KEY` in `.env`.

### Example (text)

```
TOP 10 MOVIES & TV SHOWS
Country: US  |  Generated: 2026-10-06T12:15:28.907Z
Data: Streaming Availability API (movieofthenight.com)

==================================================
Apple TV
==================================================
  Top 10 Movies
     1. F1 — 2025 | 76/100 | Drama
     ...
  Top 10 TV Shows
     1. Ted Lasso — 2020 | 84/100 | Comedy
     ...
```

`rating` is on a 0–100 scale.

## Web GUI

Start the GUI (defaults to port **9797**, override with `PORT`):

```bash
npm run web            # dev (tsx)
npm run build && npm run web:build   # compiled
```

Then open <http://localhost:9797>. The GUI is split into two tabs:

- **Dashboard** — configured-backend indicators, live Radarr/Sonarr health and
  queue sizes, request-history totals, and **Check for new titles** (dry run) /
  **Submit requests** buttons. The dry-run plan is a **sortable table** (click
  any column header) with, per title: a **TMDB poster**, year, **TMDB user
  score**, original **language**, **seasons · episodes** (TV), genres, and the
  services it appeared on. **Hover a row** to see the overview. Each title is
  **checked by default** — untick what you don't want, then submit only your
  selection. After submitting, the request history shows each title with a live
  **library status** ("up to date", percent complete, or "not in library")
  resolved from Radarr/Sonarr.
- **Settings** — pick your **country** and toggle the **streaming services**
  available for it (discovered live from the API via your key), set the items
  per list, and enter your **API / Seerr / Radarr / Sonarr** keys.

### Deployable & multi-user friendly

Settings are stored server-side in `data/config.json` (git-ignored), seeded
from `.env` on first run. Anyone can deploy toprr, open the GUI, and configure
their own keys, country and services — no file editing required.

**Secrets never reach the browser.** The API returns keys only as a masked
hint (`••••last4`); saving a blank key field keeps the existing value. All
calls to Streaming Availability, Seerr, Radarr and Sonarr happen server-side.

Activity is logged to `logs/toprr-YYYY-MM-DD.log` as newline-delimited JSON.

### Service logos

Streaming services are shown as their **dark-theme logos** rather than text —
in the settings service picker and the plan/history "On" column. Each logo is
**downloaded once** on the first `/api/countries` call, cached under
`data/service-logos/` (preserving its real format — most are SVG, some like
HBO are PNG), and served locally from `/logos/{id}` thereafter — so no repeat
calls to the media CDN. Services without a logo fall back to their name.

### TMDB enrichment & caching

Set an optional **TMDB API key** (v3) in Settings to enrich the dry-run plan
with **posters, user score, original language, season/episode counts and the
overview** (shown on row hover). Poster images come from TMDB's CDN; only the
metadata lookup needs the key. Without a key, the plan still works — posters
fall back to a placeholder and TMDB-only columns show "—".

Feed results from the Streaming Availability API are cached in-memory for
**1 hour** (per country + services + limit), so repeated dashboard checks don't
consume your monthly API quota.

### HTTP API

| Method & path        | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `GET /api/status`    | Backend health, configured flags, history summary.   |
| `GET /api/config`    | Current settings (secrets masked).                   |
| `PATCH /api/config`  | Update settings (blank secret fields are preserved). |
| `GET /api/countries` | Countries + services your API key supports.          |
| `GET /api/feed`      | Current deduplicated feeding list.                   |
| `GET /api/history`   | Request history enriched with live library status.   |
| `POST /api/sync`     | Run sync. Body `{ "submit": true }` to request.      |

All endpoints above require authentication (see below).

## Security & authentication

toprr is built to run behind a reverse proxy on the public internet. See
[`SECURITY.md`](./SECURITY.md) for the full model and audit.

### First run

On first start there are **no credentials**. Open the GUI and you'll be prompted
to **create an admin account** (username ≥3 chars, password ≥8). Passwords are
hashed with scrypt; nothing is stored in plaintext.

### Logging in

The GUI uses a session cookie (HttpOnly, SameSite=Strict, Secure behind TLS).
Change your username/password any time under **Settings → Account & API access**.
Login is rate-limited (5 failures / 15 min).

### Programmatic access (API key)

For scripts and other tools (like Sonarr/Radarr), generate an **API key** under
**Settings → Account & API access** (shown once). Send it as a header:

```bash
curl -H "X-Api-Key: <your-key>" https://toprr.example.com/api/status
curl -H "X-Api-Key: <your-key>" -H "Content-Type: application/json" \
     -X POST https://toprr.example.com/api/sync -d '{"submit":false}'
```

API-key requests are exempt from the browser CSRF check. Browser (cookie) based
mutations must send `X-Requested-With: toprr` (the GUI does this automatically).

## Deployment (Docker) — pull & run

No build tools, API keys, or config files needed up front. Clone and start:

```bash
git clone <your-gitlab-url>/toprr.git
cd toprr
docker compose up -d        # builds from source and runs
```

Then open **http://localhost:9797** and the **first-run wizard** walks you
through creating an admin account and entering your API keys (it verifies
Radarr/Sonarr/Seerr reachability as you go). Nothing else to configure.

That's the whole deployment — a multi-stage, **non-root** image that builds from
the cloned source (no registry or CI required). Config (credential hashes +
your keys) and logs persist in named volumes (`toprr-data`, `toprr-logs`), so
they survive `docker compose down && up`. The container runs `read_only` with
`no-new-privileges`.

### Reaching it from another device

By default the compose file binds to `127.0.0.1:9797` (localhost only) — the
safe default for running behind a reverse proxy. To reach it from another
machine on your LAN while testing, change the port mapping in
`docker-compose.yml`:

```yaml
    ports:
      - "9797:9797"   # all interfaces (LAN) instead of 127.0.0.1:9797
```

For public/internet exposure, keep the `127.0.0.1` bind and put a
TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front — never expose
the raw HTTP port. Forward `X-Forwarded-Proto: https` so the session cookie gets
the `Secure` flag, and ensure only the proxy can reach the app port (rate
limiting trusts `X-Forwarded-For`).

### Verify it's up

```bash
curl -fsS http://localhost:9797/api/auth/status
# {"needsSetup":true,...}  on a fresh deploy
```

Or run the included smoke test: `./scripts/smoke-test.sh [base-url]`.

Reverse-proxy notes:
- Forward `X-Forwarded-Proto: https` so toprr enforces the `Secure` cookie flag.
- Only let the proxy reach the app port (rate limiting trusts `X-Forwarded-For`).


import { buildFeed, renderFeedText } from "./src/feed.js";

const feed = await buildFeed({
  apiKey: process.env.STREAMING_AVAILABILITY_API_KEY!,
  country: "us",                      // optional, defaults to "us"
  limit: 10,                          // optional, defaults to 10
  services: ["apple", "netflix"],     // optional, defaults to apple/netflix/prime/hbo
});

// Structured per-service data: feed.services[].movies / .series
// Each item: { rank, showType, title, year, rating, genres, cast, overview, imdbId, tmdbId }

console.log(renderFeedText(feed)); // or JSON.stringify(feed)
```

## Configuration

Everything can be set in the GUI, but these environment variables **seed** the
initial config (and support headless CLI use):

| Env var                          | Default | Description                                       |
| -------------------------------- | ------- | ------------------------------------------------- |
| `STREAMING_AVAILABILITY_API_KEY` | —       | Streaming Availability key (sent as `X-API-Key`). |
| `FEED_COUNTRY`                   | `us`    | ISO 3166-1 alpha-2 country code.                  |
| `FEED_SERVICES`                  | `apple,netflix,prime,hbo` | Comma-separated service codes.   |
| `FEED_LIMIT`                     | `10`    | Items per Top list.                               |
| `SEERR_URL` / `SEERR_API_KEY`    | —       | Overseerr / Jellyseerr instance.                  |
| `RADARR_URL` / `RADARR_API_KEY`  | —       | Radarr backend (movie status).                    |
| `SONARR_URL` / `SONARR_API_KEY`  | —       | Sonarr backend (TV status).                       |
| `PORT`                           | `9797`  | Web GUI port.                                     |
| `LOG_DIR`                        | `logs`  | Directory for log files.                          |

`.env`, `data/` and `logs/` are git-ignored, so keys are never committed.

## Attribution

The `streaming-availability` client is MIT-licensed, but the **Streaming
Availability API itself has
[Terms & Conditions](https://developers.movieofthenight.com/terms-and-conditions)**.
Notably, **if you make the data public you must attribute the API.** Include a
credit such as:

> Streaming data provided by the [Streaming Availability API](https://www.movieofthenight.com/about/api)
> by Movie of the Night.

The text output already includes a `Data: Streaming Availability API` line for
this reason.
