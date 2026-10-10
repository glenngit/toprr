# toprr — Top 10 Streaming Feed

A deployable TypeScript app that fetches the daily **Top 10 movies and TV shows**
from your chosen streaming services using the
[Streaming Availability API](https://www.movieofthenight.com/about/api),
deduplicates them into a single feeding list, and requests genuinely new titles
via **Radarr / Sonarr** (or optionally **Seerr**) — never
re-requesting anything already in your library.

The services you can pick are **discovered live from the API per country**, so
the exact list depends on where you are — common ones include Netflix, Amazon
Prime Video, Disney+, Apple TV, Max, Hulu, Paramount+, Peacock and many regional
providers. You choose which to track in the GUI.

It ships with a **web GUI** (default port **9797**) to configure everything
(API keys, country, services), run syncs, and watch request status pulled live
from **Radarr** and **Sonarr**. It also works headless via CLI for a daily cron.

Output is **text-only** (no images). The feed function is importable so other
services can pull the latest list directly.

## How it works

- Uses the official [`streaming-availability`](https://github.com/movieofthenight/ts-streaming-availability)
  TypeScript client.
- Calls the **Get Top Shows** endpoint (`client.showsApi.getTopShows`) **once per
  selected service**. A single unfiltered call returns both movies and series
  (ordered by rank), which we split client-side. Top lists are determined by
  each streaming service itself and refreshed **daily** by the API.
- **Services are discovered live per country** via the `/api/countries` endpoint
  (which services your API key supports where). You pick which ones to track in
  the GUI — there's no fixed list baked into the app. A fresh install seeds a
  small sensible default set (Apple TV, Netflix, Amazon Prime Video, Max) that
  you can change immediately.

> Note: for some service/type combinations the API returns fewer than 10 titles.
> The feed includes whatever the API provides, up to the configured limit.

### API usage

Each run makes **one call per selected service** (so tracking 4 services = 4
calls). Running once a day with a handful of services stays comfortably within
the free **1000 calls/month** quota. Feed results are also cached in-memory for
**1 hour**, so repeated dashboard checks don't spend extra quota. The live quota
(used / remaining) is shown on the Dashboard, read from the API's response
headers.

## Prerequisites

Before you can use toprr you need **a Streaming Availability API key** — the app
cannot fetch any Top 10 data without it.

1. **Streaming Availability API key — required.** Sign up (free or paid) at
   **<https://www.movieofthenight.com/signup>**. The **free tier includes 1000
   requests per month**, which is plenty for a once-a-day run tracking a handful
   of services (one request per selected service per run). This key is what
   enables the whole product.
2. **Radarr and/or Sonarr — required to request titles.** Movies are requested
   to **Radarr**, TV to **Sonarr**, and both report the live library status
   shown in the GUI. You need at least one of them (Radarr for movies, Sonarr for
   TV) with its URL + API key. This is the **default** request path — no Seerr
   required.
3. **Seerr — optional.** If you prefer to route requests through **Seerr**
   instead of hitting Radarr/Sonarr directly, set the request provider to Seerr
   and provide its URL + API key. Entirely optional.
4. **TMDB API key — strongly recommended (optional).** ⭐ **The TMDB v3 key is
   what enables TMDB user ratings, posters, original language, season/episode
   counts and the overview.** Without it toprr still works, but the plan/history
   show **no ratings or poster images** and TMDB-only columns display "—". If you
   want the rich, informative listing, get a free key from
   [TMDB → Settings → API](https://www.themoviedb.org/settings/api) and add it in
   Settings. On that page TMDB shows **two** credentials — toprr accepts
   **either**: the short **API Key (v3 auth)** (32-char hex) or the long
   **API Read Access Token (v4 auth)** (an `eyJ…` token). Only the metadata
   lookup needs the key; poster images come from TMDB's public CDN. Use the
   **Test key** button in Settings to confirm it's valid.

> You enter all of these in the **first-run wizard** / **Settings** — no file
> editing required. The environment variables below are only for seeding or
> headless CLI use.

## Setup

The easiest path is **Docker** (see [Deployment](#deployment-docker--pull--run)
below): `docker compose up -d`, open the GUI, and the **first-run wizard** walks
you through creating an admin account and entering your keys — **no `.env`, no
file editing**. All keys (Streaming Availability, TMDB, Radarr/Sonarr/Seerr) are
entered in the wizard / **Settings** and stored server-side.

To run from source instead (requires Node.js 18+, tested on Node 22):

```bash
npm install
npm run build
npm run serve        # then open http://localhost:9797 and complete the wizard
```

### How the API key is used

The Streaming Availability API authenticates via an **`X-API-Key`** header, which
the client sends automatically from the key you entered in the wizard / Settings.
Keys live **server-side only** (in `data/config.json`, git-ignored) and are never
sent to the browser. See the
[Authentication guide](https://docs.movieofthenight.com/guide/authentication).

> **Optional — headless / CLI seeding.** If you run the CLI commands below (or
> want to pre-seed config on first boot) you can instead put keys in a `.env`
> file (`cp .env.example .env`). This is **not required** for the GUI — the
> wizard is the normal way to configure everything. See
> [Configuration](#configuration) for the full list of seed variables.

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

### Request handling (Radarr / Sonarr, or Seerr)

`sync` builds the deduplicated feed, then for each title checks your backend and
**skips anything that already exists or has already been requested**. Only
genuinely new titles are requested. The **default provider is Radarr / Sonarr
directly** (no Seerr needed); set `REQUEST_PROVIDER=seerr` (or pick it in
Settings) to route through **Seerr** instead.

- **IDs**: requests use the numeric TMDB id (parsed from the Streaming
  Availability API's `movie/…` / `tv/…` form) routed by media type —
  movies to Radarr, TV to Sonarr.
- **Quality profile & root folder**: with Radarr/Sonarr direct you may pick a
  quality profile and root folder per backend in Settings (otherwise the
  backend defaults apply). With Seerr, each default server's own defaults apply.
- **TV seasons**: in the GUI you choose seasons **per show** — the default is
  **Season 1 only** (so an old multi-season show in the Top 10 doesn't pull
  every season), with one-click **All**, **S1 only**, or a per-season checkbox
  picker (e.g. seasons 2–4 of 8). The headless CLI defaults to **season 1**.
  The requested seasons are recorded in the history.
- `sync` is a **dry run** by default; `sync:submit` is required to actually
  submit. This makes the automated once-a-day run safe to review first.

Radarr/Sonarr are configured with their URL + API key; Seerr (if used) needs
`SEERR_URL` and `SEERR_API_KEY`. All of this can be set in Settings or via `.env`.

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

Then open <http://localhost:9797>. The GUI has a top navigation (a hamburger
drawer on mobile) with these sections:

- **Dashboard** — feed settings (country, services, items per list), configured-
  backend indicators, live Radarr/Sonarr health and queue sizes, the live
  **Streaming API quota**, and **Check for new titles** (dry run) / **Submit
  requests** buttons. The dry-run plan is a **sortable table** (click any column
  header on desktop, or use the sort dropdown on mobile) with, per title: a
  **TMDB poster**, year, **TMDB user score**, original **language**,
  **seasons · episodes** (TV), genres, and the services it appeared on. **Hover a
  row** (or tap for details) to see the overview. Each title is **checked by
  default** — untick what you don't want, then submit only your selection. A
  **recent-requests** preview (last 5 on mobile, 10 on desktop) sits below.
- **Requests** — the full request history with **title search**, a selectable
  **page size**, and Prev/Next paging. Each row shows a live **library status**
  ("up to date", percent complete, downloading %, or "not in library") resolved
  from Radarr/Sonarr, plus retry/remove for failed requests.
- **Settings** — pick your **country** and toggle the **streaming services**
  available for it (discovered live from the API via your key), set items per
  list, choose the **request provider** (Radarr/Sonarr direct or Seerr), and
  enter your **API / TMDB / Radarr / Sonarr / Seerr** keys. Also manage your
  **account** and generate an **API key** for programmatic access.
- **Documentation and API** — a short usage guide plus the interactive
  **Swagger / OpenAPI** reference (served at `/docs`).
- **About** — app info, version, and changelog.

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

Set an optional **TMDB API key** in Settings to enrich the dry-run plan
with **posters, user score, original language, season/episode counts and the
overview** (shown on row hover). toprr accepts **either** TMDB credential — the
v3 **API Key** or the v4 **API Read Access Token** — and picks the right auth
automatically. Poster images come from TMDB's CDN; only the metadata lookup
needs the key. Without a key, the plan still works — posters fall back to a
placeholder and TMDB-only columns show "—".

Feed results from the Streaming Availability API are cached in-memory for
**1 hour** (per country + services + limit), so repeated dashboard checks don't
consume your monthly API quota.

### Troubleshooting: no posters, score, or language

If the plan/history shows **no poster images, no TMDB score, and the Language
column is "—"**, your TMDB credential is almost certainly missing or invalid.
TMDB's [Settings → API](https://www.themoviedb.org/settings/api) page lists
**two** values and it's easy to grab the wrong one:

- **API Key (v3 auth)** — a short **32-character hex** string.
- **API Read Access Token (v4 auth)** — a long **`eyJ…`** token.

toprr accepts **either**, so paste whichever you have. Then hit the **Test key**
button in **Settings → API keys**: it confirms "Valid TMDB key / v4 token" or
tells you it's invalid. (If you set the key via `TMDB_API_KEY` in `.env`, the
same rule applies.)

### HTTP API

A few of the most useful endpoints (the **full, interactive reference** lives in
the GUI under **Documentation and API**, served at `/docs`, with the raw schema
at `/openapi.json`):

| Method & path        | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `GET /api/status`    | Backend health, configured flags, history summary, version, quota. |
| `GET /api/config`    | Current settings (secrets masked).                   |
| `PATCH /api/config`  | Update settings (blank secret fields are preserved). |
| `GET /api/countries` | Countries + services your API key supports.          |
| `GET /api/feed`      | Current deduplicated feeding list.                   |
| `GET /api/history`   | Request history (search via `q`, paged) with live library status. |
| `POST /api/sync`     | Run sync. Body `{ "submit": true }` to request.      |

All endpoints except the auth/setup/login routes require authentication (see
below). The GUI also exposes account, API-key, countries and connection-test
endpoints — see the OpenAPI reference for the complete list.

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
git clone https://github.com/glenngit/toprr.git
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

### Pull the prebuilt image from GHCR

Prefer not to build from source? A multi-arch image (`linux/amd64` +
`linux/arm64`) is published to the GitHub Container Registry on every push to
`main` and every `v*` tag:

```bash
docker pull ghcr.io/glenngit/toprr:latest
```

Run it directly:

```bash
docker run -d --name toprr -p 9797:9797 \
  -v toprr-data:/app/data -v toprr-logs:/app/logs \
  ghcr.io/glenngit/toprr:latest
```

Or point Compose at the published image instead of building locally — edit
`docker-compose.yml` and replace `build: .` with:

```yaml
    image: ghcr.io/glenngit/toprr:latest
```

Pin to a release tag (e.g. `:1.0.1`) instead of `:latest` for reproducible
deploys. The image is public, so no `docker login` is needed to pull.

### Reaching it from another device

By default the compose file binds to **all interfaces** (`9797:9797`), so the
GUI is reachable from other machines on your network at
`http://<host-ip>:9797` — convenient for a quick LAN deploy. (If a host
firewall is active, allow inbound TCP `9797`.)

For **public/internet exposure**, don't expose the raw HTTP port. Restrict the
bind to localhost and put a TLS-terminating reverse proxy (Caddy, nginx,
Traefik) in front — change the port mapping in `docker-compose.yml`:

```yaml
    ports:
      - "127.0.0.1:9797:9797"   # localhost only — reach it via your reverse proxy
```

Forward `X-Forwarded-Proto: https` so the session cookie gets the `Secure`
flag, and ensure only the proxy can reach the app port (rate limiting trusts
`X-Forwarded-For`).

### Reverse proxies

toprr works out of the box behind any standard reverse proxy or CDN —
**HAProxy, NGINX, Caddy, Traefik, Cloudflare** and the like. **Nothing needs to
be configured inside the application** for them to work: toprr is a plain HTTP
server with no base-path assumptions, so you just point the proxy at it and go.
It already honours the two de-facto standard forwarded headers:

- `X-Forwarded-Proto: https` — tells toprr the external connection is TLS, so it
  sets the session cookie's `Secure` flag. (Most proxies send this automatically;
  with Cloudflare it's set for you.)
- `X-Forwarded-For` — used for login rate-limiting, so limits apply to the real
  client IP rather than the proxy's.

Both are optional — the app runs fine without them — but forwarding them is
recommended for correct `Secure`-cookie and rate-limit behaviour. There are no
custom headers, no sub-path rewriting, and no app settings to change; the only
hardening step is the usual one of making sure **only the proxy can reach the
app port** (switch the port mapping to the `127.0.0.1` bind shown above).

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
  services: ["apple", "netflix"],     // optional; defaults seed apple/netflix/prime/hbo
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
| `TMDB_API_KEY`                   | —       | Optional TMDB key — v3 API key **or** v4 Read Access Token; enables posters, score, language, seasons. |
| `FEED_COUNTRY`                   | `us`    | ISO 3166-1 alpha-2 country code.                  |
| `FEED_SERVICES`                  | `apple,netflix,prime,hbo` | Comma-separated service codes (seed only). |
| `FEED_LIMIT`                     | `10`    | Items per Top list.                               |
| `REQUEST_PROVIDER`               | `arr`   | `arr` = Radarr/Sonarr direct (default), or `seerr`. |
| `SEERR_URL` / `SEERR_API_KEY`    | —       | Seerr instance (only if `REQUEST_PROVIDER=seerr`). |
| `RADARR_URL` / `RADARR_API_KEY`  | —       | Radarr backend (movie requests + status).         |
| `SONARR_URL` / `SONARR_API_KEY`  | —       | Sonarr backend (TV requests + status).            |
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
