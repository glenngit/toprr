import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { ConfigStore, type ConfigUpdate } from "./config.js";
import { discoverCountries } from "./countries.js";
import { LogoCache } from "./logos.js";
import { ArrClient } from "./arr.js";
import { HistoryStore } from "./history.js";
import { dedupeFeed } from "./seerr.js";
import { buildFeed } from "./feed.js";
import { runSync, requestOne } from "./sync.js";
import { testConnection, type TestKind } from "./testConnection.js";
import { getQuota } from "./quota.js";
import { TmdbClient } from "./tmdb.js";
import { Logger } from "./logger.js";
import {
  hashPassword,
  verifyPassword,
  generateApiKey,
  apiKeyMatches,
  signSession,
  verifySignedSession,
} from "./auth.js";
import { SessionStore, LoginRateLimiter } from "./session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

// App version, read once from package.json (project root is one level up from
// both src/ (tsx) and dist/ (compiled)). Falls back to "unknown" if unreadable.
const APP_VERSION: string = await (async () => {
  try {
    const raw = await readFile(join(__dirname, "..", "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
})();

const configStore = new ConfigStore();
const history = new HistoryStore();
const logger = new Logger();
const logoCache = new LogoCache();
const sessions = new SessionStore();
const loginLimiter = new LoginRateLimiter();

const COOKIE_NAME = "toprr_session";
const MAX_BODY_BYTES = 1024 * 256; // 256 KiB cap on request bodies

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/** Apply security headers to every response (defense-in-depth behind a proxy). */
function securityHeaders(res: ServerResponse, pathname = ""): void {
  // The API docs page loads Swagger UI from a CDN, so it needs a relaxed CSP.
  // It's public static reference material with no secrets, so this is safe and
  // scoped only to the /docs page.
  const isDocs = pathname === "/docs" || pathname === "/docs.html";
  const csp = isDocs
    ? [
        "default-src 'self'",
        "img-src 'self' https://image.tmdb.org data: https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "connect-src 'self'",
        "frame-ancestors 'none'",
      ]
    : [
        "default-src 'self'",
        "img-src 'self' https://image.tmdb.org https://cdn.movieofthenight.com data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ];
  res.setHeader("Content-Security-Policy", csp.join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
}

/** Parse a specific cookie value from the Cookie header. */
function getCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Set the signed, HttpOnly session cookie. `Secure` only over real HTTPS. */
function setSessionCookie(req: IncomingMessage, res: ServerResponse, signed: string): void {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(signed)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (isHttps(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

/**
 * Whether the request reached us over HTTPS. We mark the session cookie
 * `Secure` only in this case — setting `Secure` over plain HTTP makes browsers
 * silently drop the cookie, which would break login entirely.
 *
 * Behind a reverse proxy that terminates TLS, forward `X-Forwarded-Proto: https`
 * (standard) so toprr enables `Secure`. A direct TLS socket is also honored.
 */
function isHttps(req: IncomingMessage): boolean {
  const xfp = req.headers["x-forwarded-proto"];
  if (typeof xfp === "string" && xfp.split(",")[0].trim().toLowerCase() === "https") {
    return true;
  }
  // Direct TLS connection (no proxy): the socket is a TLSSocket when encrypted.
  return Boolean((req.socket as unknown as { encrypted?: boolean }).encrypted);
}

/** Best-effort client identifier for rate limiting (honors proxy header). */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

type AuthResult = { ok: true; via: "session" | "apikey" } | { ok: false };

/**
 * Authenticate a request via a valid session cookie OR a matching X-Api-Key.
 * Returns how it authenticated (used to decide whether CSRF checks apply).
 */
async function authenticate(req: IncomingMessage): Promise<AuthResult> {
  const auth = await configStore.getAuth();

  // API key (programmatic): header check, constant-time compared against hash.
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader && auth.apiKeyHash) {
    if (apiKeyMatches(apiKeyHeader, auth.apiKeyHash)) return { ok: true, via: "apikey" };
  }

  // Session cookie (browser).
  const cookie = getCookie(req, COOKIE_NAME);
  if (cookie && auth.sessionSecret) {
    const sid = verifySignedSession(cookie, auth.sessionSecret);
    if (sid && sessions.isValid(sid)) return { ok: true, via: "session" };
  }

  return { ok: false };
}

/**
 * CSRF defense: for cookie-authenticated mutations, require a custom header
 * that browsers only send for same-origin fetches (SameSite=Strict already
 * blocks cross-site cookies, this is belt-and-braces). API-key callers are
 * exempt because they don't rely on ambient cookie auth.
 */
function csrfOk(req: IncomingMessage, via: "session" | "apikey"): boolean {
  if (via === "apikey") return true;
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return true;
  return req.headers["x-requested-with"] === "toprr";
}

/**
 * Persistent ArrClient so its Radarr/Sonarr index caches survive across
 * requests (rebuilding the full series list on every page load was the main
 * cause of slow history loads). Rebuilt only when the backend config changes.
 */
let arrClient: ArrClient | undefined;
let arrClientKey = "";
async function arrFromConfig(): Promise<ArrClient> {
  const config = await configStore.load();
  const key = [
    config.radarr.url, config.radarr.apiKey,
    config.sonarr.url, config.sonarr.apiKey,
  ].join("|");
  if (!arrClient || key !== arrClientKey) {
    arrClient = new ArrClient({
      radarrUrl: config.radarr.url || undefined,
      radarrApiKey: config.radarr.apiKey || undefined,
      sonarrUrl: config.sonarr.url || undefined,
      sonarrApiKey: config.sonarr.apiKey || undefined,
    });
    arrClientKey = key;
  }
  return arrClient;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = resolve(PUBLIC_DIR, "." + rel);
  // Robust containment check: resolved path must be PUBLIC_DIR itself or a
  // descendant (guards against ../ traversal and sibling-prefix tricks).
  const within = resolved === PUBLIC_DIR || resolved.startsWith(PUBLIC_DIR + sep);
  const safe = within ? resolved : join(PUBLIC_DIR, "index.html");
  try {
    const data = await readFile(safe);
    const ext = safe.slice(safe.lastIndexOf("."));
    // Content-hash ETag + must-revalidate: browsers may cache, but always
    // revalidate, so an updated asset (new hash) is fetched immediately.
    const etag = `"${createHash("sha1").update(data).digest("base64url")}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      ETag: etag,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// Static assets that MUST be reachable without a session so the login / first-run
// screen can render and function. These are UI shell files and icons with no
// secrets. Everything else static (e.g. /docs, /openapi.json) requires auth.
const PUBLIC_STATIC = new Set<string>([
  "/",
  "/index.html",
  "/app.js",
  "/logo.png",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/favicon-32.png",
  "/favicon-48.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
]);

/**
 * Auth gate for static files. The login-screen allowlist is served to anyone;
 * all other static files (docs page, OpenAPI schema, etc.) require a valid
 * session or API key — matching the protection on the data endpoints.
 */
async function serveStaticGated(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<void> {
  if (!PUBLIC_STATIC.has(urlPath)) {
    const a = await authenticate(req);
    if (!a.ok) {
      // For the docs HTML page, redirect browsers to the GUI (which shows the
      // login gate) rather than returning a bare 401 body.
      if (urlPath === "/docs.html") {
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      return sendJson(res, 401, { error: "Authentication required" });
    }
  }
  return serveStatic(req, res, urlPath);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  // ---- Public auth endpoints (no session required) ----

  // GET /api/auth/status -> whether setup is needed and whether logged in.
  if (pathname === "/api/auth/status" && method === "GET") {
    const needsSetup = await configStore.needsSetup();
    const authed = (await authenticate(req)).ok;
    const auth = await configStore.getAuth();
    return sendJson(res, 200, { needsSetup, authenticated: authed, username: auth.username || null });
  }

  // POST /api/auth/setup -> first-run only: create the admin account.
  if (pathname === "/api/auth/setup" && method === "POST") {
    if (!(await configStore.needsSetup())) {
      return sendJson(res, 409, { error: "Setup already completed" });
    }
    const body = ((await readBody(req)) ?? {}) as { username?: string; password?: string };
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    if (username.length < 3 || password.length < 8) {
      return sendJson(res, 400, {
        error: "Username must be ≥3 chars and password ≥8 chars.",
      });
    }
    const auth = await configStore.getAuth();
    await configStore.setAuth({
      ...auth,
      username,
      passwordHash: await hashPassword(password),
    });
    const sid = sessions.create();
    setSessionCookie(req, res, signSession(sid, auth.sessionSecret));
    await logger.info("admin account created (first-run setup)", { username });
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/auth/login -> username+password, rate-limited.
  if (pathname === "/api/auth/login" && method === "POST") {
    const ip = clientIp(req);
    if (!loginLimiter.allowed(ip)) {
      res.setHeader("Retry-After", String(loginLimiter.retryAfterSec(ip)));
      return sendJson(res, 429, { error: "Too many attempts. Try again later." });
    }
    const body = ((await readBody(req)) ?? {}) as { username?: string; password?: string };
    const auth = await configStore.getAuth();
    const userOk = (body.username ?? "") === auth.username;
    const passOk = await verifyPassword(body.password ?? "", auth.passwordHash);
    if (!userOk || !passOk) {
      loginLimiter.recordFailure(ip);
      await logger.warn("failed login", { ip });
      return sendJson(res, 401, { error: "Invalid username or password." });
    }
    loginLimiter.reset(ip);
    const sid = sessions.create();
    setSessionCookie(req, res, signSession(sid, auth.sessionSecret));
    await logger.info("login", { username: auth.username, ip });
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/auth/logout -> destroy the current session.
  if (pathname === "/api/auth/logout" && method === "POST") {
    const cookie = getCookie(req, COOKIE_NAME);
    const auth = await configStore.getAuth();
    if (cookie && auth.sessionSecret) {
      const sid = verifySignedSession(cookie, auth.sessionSecret);
      if (sid) sessions.destroy(sid);
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/test-connection { kind, url, apiKey } -> verify reachability.
  // Allowed during first-run setup (no account yet) OR when authenticated.
  if (pathname === "/api/test-connection" && method === "POST") {
    const inSetup = await configStore.needsSetup();
    if (!inSetup) {
      const a = await authenticate(req);
      if (!a.ok) return sendJson(res, 401, { error: "Authentication required" });
      if (!csrfOk(req, a.via)) return sendJson(res, 403, { error: "CSRF check failed" });
    }
    const body = ((await readBody(req)) ?? {}) as {
      kind?: TestKind;
      url?: string;
      apiKey?: string;
    };
    const kind = body.kind;
    if (!kind || !["streaming", "radarr", "sonarr", "seerr", "tmdb"].includes(kind)) {
      return sendJson(res, 400, { error: "Invalid connection kind" });
    }
    // If the apiKey is blank, fall back to the stored key (so a user can
    // re-test without re-typing a saved secret).
    let apiKey = (body.apiKey ?? "").trim();
    let url = (body.url ?? "").trim();
    if (!apiKey || !url) {
      const cfg = await configStore.load();
      if (kind === "streaming") apiKey ||= cfg.apiKey;
      else if (kind === "tmdb") apiKey ||= cfg.tmdbApiKey;
      else if (kind === "radarr") { apiKey ||= cfg.radarr.apiKey; url ||= cfg.radarr.url; }
      else if (kind === "sonarr") { apiKey ||= cfg.sonarr.apiKey; url ||= cfg.sonarr.url; }
      else if (kind === "seerr") { apiKey ||= cfg.seerr.apiKey; url ||= cfg.seerr.url; }
    }
    const result = await testConnection(kind, url, apiKey);
    return sendJson(res, 200, result);
  }

  // ---- Auth gate: everything below requires a valid session or API key ----
  const authResult = await authenticate(req);
  if (!authResult.ok) {
    return sendJson(res, 401, { error: "Authentication required" });
  }
  if (!csrfOk(req, authResult.via)) {
    return sendJson(res, 403, { error: "CSRF check failed" });
  }

  // POST /api/auth/password -> change password (requires auth); rotates sessions.
  if (pathname === "/api/auth/password" && method === "POST") {
    const body = ((await readBody(req)) ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
    };
    const auth = await configStore.getAuth();
    if (!(await verifyPassword(body.currentPassword ?? "", auth.passwordHash))) {
      return sendJson(res, 401, { error: "Current password is incorrect." });
    }
    if ((body.newPassword ?? "").length < 8) {
      return sendJson(res, 400, { error: "New password must be ≥8 chars." });
    }
    await configStore.setAuth({ ...auth, passwordHash: await hashPassword(body.newPassword!) });
    sessions.destroyAll(); // force re-login everywhere
    clearSessionCookie(res);
    await logger.info("password changed", { username: auth.username });
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/auth/username -> change username (requires auth).
  if (pathname === "/api/auth/username" && method === "POST") {
    const body = ((await readBody(req)) ?? {}) as { username?: string };
    const username = (body.username ?? "").trim();
    if (username.length < 3) return sendJson(res, 400, { error: "Username must be ≥3 chars." });
    const auth = await configStore.getAuth();
    await configStore.setAuth({ ...auth, username });
    await logger.info("username changed", { username });
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/auth/apikey -> generate/rotate the API key; returned ONCE.
  if (pathname === "/api/auth/apikey" && method === "POST") {
    const auth = await configStore.getAuth();
    const { plaintext, hash } = generateApiKey();
    await configStore.setAuth({ ...auth, apiKeyHash: hash });
    await logger.info("api key rotated");
    return sendJson(res, 200, { apiKey: plaintext });
  }

  // DELETE /api/auth/apikey -> revoke the API key.
  if (pathname === "/api/auth/apikey" && method === "DELETE") {
    const auth = await configStore.getAuth();
    await configStore.setAuth({ ...auth, apiKeyHash: "" });
    await logger.info("api key revoked");
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/config -> masked public config
  if (pathname === "/api/config" && method === "GET") {
    const config = await configStore.load();
    return sendJson(res, 200, configStore.toPublic(config));
  }

  // PATCH /api/config -> update settings (secrets left blank are preserved)
  if (pathname === "/api/config" && method === "PATCH") {
    const body = (await readBody(req)) as ConfigUpdate;
    const updated = await configStore.update(body ?? {});
    await logger.info("config updated via GUI", {
      country: updated.country,
      services: updated.services,
    });
    return sendJson(res, 200, configStore.toPublic(updated));
  }

  // GET /api/arr-options -> quality profiles + root folders for Radarr/Sonarr,
  // so Settings can offer dropdowns. Root-folder paths appear ONLY here.
  if (pathname === "/api/arr-options" && method === "GET") {
    const arr = await arrFromConfig();
    const out: Record<string, unknown> = {};
    try {
      out.radarr = arr.radarrConfigured ? await arr.options("radarr") : null;
    } catch (err) {
      out.radarr = { error: err instanceof Error ? err.message : String(err) };
    }
    try {
      out.sonarr = arr.sonarrConfigured ? await arr.options("sonarr") : null;
    } catch (err) {
      out.sonarr = { error: err instanceof Error ? err.message : String(err) };
    }
    return sendJson(res, 200, out);
  }

  // GET /api/countries -> discovery for dropdowns (uses configured API key)
  if (pathname === "/api/countries" && method === "GET") {
    const config = await configStore.load();
    if (!config.apiKey) {
      return sendJson(res, 400, { error: "Set your Streaming Availability API key first." });
    }
    try {
      const countries = await discoverCountries(config.apiKey);
      // Cache service logos to disk on first sight; serve them locally after.
      await logoCache.primeFrom(countries);
      // Replace the remote logo URL with our local path so the browser never
      // calls the media CDN directly after the first cache.
      const withLocalLogos = countries.map((c) => ({
        ...c,
        services: c.services.map((s) => ({
          id: s.id,
          name: s.name,
          logo: s.darkThemeImage ? `/logos/${encodeURIComponent(s.id)}` : null,
        })),
      }));
      return sendJson(res, 200, { countries: withLocalLogos });
    } catch (err) {
      return sendJson(res, 502, {
        error: `Could not fetch countries: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  // GET /logos/{serviceId} -> locally cached service logo (no remote call).
  // Extension is resolved server-side (logos may be SVG or PNG).
  if (pathname.startsWith("/logos/") && method === "GET") {
    const id = decodeURIComponent(pathname.slice("/logos/".length)).replace(/\.(svg|png|jpe?g|webp)$/i, "");
    const logo = await logoCache.read(id);
    if (!logo) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": logo.contentType,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(logo.body);
    return;
  }

  // GET /api/status -> backend health + history summary
  if (pathname === "/api/status" && method === "GET") {
    const config = await configStore.load();
    const arr = await arrFromConfig();
    const [health, summary] = await Promise.all([arr.health(), history.summary()]);
    const provider = config.requestProvider ?? "arr";
    const seerrReady = Boolean(config.seerr.url && config.seerr.apiKey);
    const arrReady = Boolean(
      (config.radarr.url && config.radarr.apiKey) || (config.sonarr.url && config.sonarr.apiKey),
    );
    return sendJson(res, 200, {
      version: APP_VERSION,
      requestProvider: provider,
      // Whether the chosen provider has what it needs to submit requests.
      requestReady: provider === "seerr" ? seerrReady : arrReady,
      configured: {
        apiKey: Boolean(config.apiKey),
        seerr: seerrReady,
        radarr: Boolean(config.radarr.url && config.radarr.apiKey),
        sonarr: Boolean(config.sonarr.url && config.sonarr.apiKey),
      },
      country: config.country,
      services: config.services,
      backends: health,
      history: summary,
      quota: getQuota() ?? null,
    });
  }

  // GET /api/history?limit&offset&status -> paginated history.
  // Records return immediately; live library status is resolved only for the
  // requested page (and only when status=true) via a batched 2-call lookup.
  if (pathname === "/api/history" && method === "GET") {
    const all = await history.readAll();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 25, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const withStatus = url.searchParams.get("status") !== "false";
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();

    // Newest first, then (optionally) filter by title, then page. `total`
    // reflects the filtered set so the GUI can paginate the search results.
    let ordered = all.slice().reverse();
    if (q) ordered = ordered.filter((r) => (r.title || "").toLowerCase().includes(q));
    const total = ordered.length;
    const page = ordered.slice(offset, offset + limit);

    let records: unknown[] = page;
    if (withStatus && page.length) {
      const config = await configStore.load();
      const arr = await arrFromConfig();
      const tmdb = new TmdbClient(config.tmdbApiKey);
      const items = page.map((r) => ({ mediaType: r.mediaType, tmdbId: r.tmdbId }));
      const [statuses, details] = await Promise.all([
        arr.statusForMany(items),
        tmdb.detailsForMany(items),
      ]);
      records = page.map((r) => {
        const d = details[`${r.mediaType}:${r.tmdbId}`];
        return {
          ...r,
          status: statuses[`${r.mediaType}:${r.tmdbId}`],
          poster: d?.poster ?? null,
          // Prefer the live TMDB user score; falls back to "—" in the GUI
          // when neither TMDB nor the stored score has a real value.
          tmdbScore: d?.voteAverage ?? null,
        };
      });
    }
    return sendJson(res, 200, { records, total, limit, offset });
  }

  // POST /api/history/retry { id } -> re-submit a failed title via the provider.
  if (pathname === "/api/history/retry" && method === "POST") {
    const body = ((await readBody(req)) ?? {}) as { id?: string };
    const all = await history.readAll();
    const rec = all.find((r) => r.id === body.id);
    if (!rec) return sendJson(res, 404, { error: "History item not found" });
    const config = await configStore.load();
    const seasons = rec.mediaType === "tv" ? rec.seasons ?? [1] : "all";
    const result = await requestOne(
      config,
      { mediaType: rec.mediaType, tmdbId: rec.tmdbId, title: rec.title },
      seasons,
    );
    const patched = await history.update(rec.id!, {
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      requestedAt: new Date().toISOString(),
    });
    await logger.info("history retry", { title: rec.title, ok: result.ok });
    return sendJson(res, result.ok ? 200 : 502, {
      ok: result.ok,
      error: result.ok ? undefined : (result as { error: string }).error,
      record: patched,
    });
  }

  // POST /api/history/remove { id } -> delete a history item (local record only).
  if (pathname === "/api/history/remove" && method === "POST") {
    const body = ((await readBody(req)) ?? {}) as { id?: string };
    if (!body.id) return sendJson(res, 400, { error: "Missing id" });
    const removed = await history.remove(body.id);
    if (!removed) return sendJson(res, 404, { error: "History item not found" });
    await logger.info("history item removed", { id: body.id });
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/feed -> current deduped feeding list (no requests)
  if (pathname === "/api/feed" && method === "GET") {
    const config = await configStore.load();
    if (!config.apiKey) return sendJson(res, 400, { error: "API key not set" });
    const feed = await buildFeed({
      apiKey: config.apiKey,
      country: config.country,
      limit: config.limit,
      services: config.services,
      cacheMs: 60 * 60 * 1000,
    });
    return sendJson(res, 200, { entries: dedupeFeed(feed) });
  }

  // POST /api/sync { submit?, only?, seasonsByKey? } -> run sync (dry-run by default)
  if (pathname === "/api/sync" && method === "POST") {
    const body = ((await readBody(req)) ?? {}) as {
      submit?: boolean;
      only?: string[];
      seasonsByKey?: Record<string, "all" | number[]>;
    };
    const config = await configStore.load();
    try {
      const result = await runSync(
        config,
        {
          submit: Boolean(body.submit),
          only: Array.isArray(body.only) ? body.only : undefined,
          seasonsByKey:
            body.seasonsByKey && typeof body.seasonsByKey === "object"
              ? body.seasonsByKey
              : undefined,
        },
        { history, logger },
      );
      // Enrich the plan with TMDB details (poster, score, language,
      // The feed already carries poster/overview/cast/runtime/etc from the
      // Streaming Availability imageSet — no TMDB needed for those. TMDB (if a
      // key is set) only *supplements*: the user score and the per-season list
      // for the season picker, plus a fallback poster/overview.
      const tmdb = new TmdbClient(config.tmdbApiKey);
      const details = await tmdb.detailsForMany(result.plan);
      const plan = result.plan.map((e) => {
        const d = e.tmdbId !== undefined ? details[`${e.mediaType}:${e.tmdbId}`] : undefined;
        return {
          ...e,
          poster: e.poster ?? d?.poster ?? null,
          overview: e.overview || d?.overview || null,
          tmdbScore: d?.voteAverage ?? null,
          originalLanguage: d?.originalLanguage ?? null,
          // Prefer the feed's own counts; fall back to TMDB.
          seasonCount: e.seasonCount ?? d?.numberOfSeasons ?? null,
          episodes: e.episodeCount ?? d?.numberOfEpisodes ?? null,
          runtime: e.runtime ?? d?.runtime ?? null,
          // Per-season list only comes from TMDB (feed doesn't provide it).
          seasonList: d?.seasons ?? null,
        };
      });
      return sendJson(res, 200, {
        dryRun: result.dryRun,
        uniqueCount: result.uniqueCount,
        skippedExisting: result.skippedExisting.length,
        plan,
        posterSource: "imageset",
        requested: result.requested.length,
        failed: result.failed,
        // The feed build above went through quotaFetch, so this is the latest
        // snapshot — returned so the GUI can refresh the meter without a
        // separate /api/status round-trip.
        quota: getQuota() ?? null,
      });
    } catch (err) {
      return sendJson(res, 502, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  securityHeaders(res, url.pathname);
  // /docs -> Swagger UI reference page (requires auth; see gating below).
  const path = url.pathname === "/docs" ? "/docs.html" : url.pathname;
  const handler = url.pathname.startsWith("/api/") || url.pathname.startsWith("/logos/")
    ? handleApi(req, res, url)
    : serveStaticGated(req, res, path);
  Promise.resolve(handler).catch((err) => {
    // Never leak internal error details to the client.
    const msg = err instanceof Error && err.message === "Request body too large"
      ? "Request body too large"
      : "Internal server error";
    const status = msg === "Request body too large" ? 413 : 500;
    if (!res.headersSent) sendJson(res, status, { error: msg });
  });
});

const port = Number(process.env.PORT ?? "9797") || 9797;
server.listen(port, () => {
  void logger.info("toprr web GUI started", { port });
  console.error(`toprr web GUI listening on http://localhost:${port}`);
});
