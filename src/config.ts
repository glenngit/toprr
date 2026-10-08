import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomToken } from "./auth.js";

/**
 * Persisted, GUI-manageable application config.
 *
 * This is what makes toprr a deployable app: instead of editing .env, a
 * deployer configures everything through the web GUI, and it's saved here
 * (data/config.json). On first run the file is seeded from environment
 * variables so an operator who prefers .env still gets a working instance.
 *
 * Secrets are stored in plain text on disk (server-side only, git-ignored),
 * but are NEVER sent to the browser — see toPublic().
 */
export interface AppConfig {
  /** Streaming Availability API key (X-API-Key). */
  apiKey: string;
  /** ISO 3166-1 alpha-2 country code to pull Top 10 for. */
  country: string;
  /** Selected streaming service ids (e.g. ["apple","netflix","prime","hbo"]). */
  services: string[];
  /** How many items per Top list. */
  limit: number;

  /** Optional TMDB API key (v3) used only to resolve poster images. */
  tmdbApiKey: string;
  /**
   * Which backend handles requests: "arr" (add directly to Radarr/Sonarr) or
   * "seerr" (submit to Overseerr/Jellyseerr). Seerr is optional — the default
   * is "arr" so a minimal Radarr+Sonarr setup needs no Seerr at all.
   */
  requestProvider: "arr" | "seerr";

  seerr: { url: string; apiKey: string };
  /** For the "arr" provider: chosen quality profile id + root folder path. */
  radarr: { url: string; apiKey: string; qualityProfileId?: number; rootFolder?: string };
  sonarr: { url: string; apiKey: string; qualityProfileId?: number; rootFolder?: string };

  /**
   * Authentication state. All values are secrets/hashes kept server-side and
   * are NEVER included in PublicConfig. When username/passwordHash are empty
   * the app is in "first-run setup" mode.
   */
  auth: {
    username: string;
    /** scrypt hash string, or "" before setup. */
    passwordHash: string;
    /** SHA-256 hash of the API key, or "" if no key issued. */
    apiKeyHash: string;
    /** HMAC secret for signing session cookies; generated on first run. */
    sessionSecret: string;
  };
}

/** Config with every secret replaced by a boolean "isSet" flag + masked hint. */
export interface PublicConfig {
  country: string;
  services: string[];
  limit: number;
  apiKey: MaskedSecret;
  tmdbApiKey: MaskedSecret;
  requestProvider: "arr" | "seerr";
  seerr: { url: string; apiKey: MaskedSecret };
  radarr: { url: string; apiKey: MaskedSecret; qualityProfileId?: number; rootFolder?: string };
  sonarr: { url: string; apiKey: MaskedSecret; qualityProfileId?: number; rootFolder?: string };
  /** Auth status only — never the username's password or key material. */
  auth: { username: string; apiKeySet: boolean };
}

export interface MaskedSecret {
  /** Whether a value is configured. */
  set: boolean;
  /** A safe hint like "••••last4" — never the full secret. */
  hint: string;
}

const DEFAULT_PATH = "data/config.json";

function mask(secret: string | undefined): MaskedSecret {
  if (!secret) return { set: false, hint: "" };
  const last4 = secret.slice(-4);
  return { set: true, hint: `••••${last4}` };
}

function seedFromEnv(): AppConfig {
  const servicesEnv = process.env.FEED_SERVICES;
  return {
    apiKey: process.env.STREAMING_AVAILABILITY_API_KEY ?? "",
    country: process.env.FEED_COUNTRY ?? "us",
    // Default to the four services this project was built around.
    services: servicesEnv
      ? servicesEnv.split(",").map((s) => s.trim()).filter(Boolean)
      : ["apple", "netflix", "prime", "hbo"],
    limit: Number(process.env.FEED_LIMIT ?? "10") || 10,
    tmdbApiKey: process.env.TMDB_API_KEY ?? "",
    // Default to direct Radarr/Sonarr so Seerr is optional for the public release.
    requestProvider: (process.env.REQUEST_PROVIDER as "arr" | "seerr") || "arr",
    seerr: {
      url: process.env.SEERR_URL ?? "",
      apiKey: process.env.SEERR_API_KEY ?? "",
    },
    radarr: {
      url: process.env.RADARR_URL ?? "",
      apiKey: process.env.RADARR_API_KEY ?? "",
      qualityProfileId: process.env.RADARR_PROFILE_ID ? Number(process.env.RADARR_PROFILE_ID) : undefined,
      rootFolder: process.env.RADARR_ROOT || undefined,
    },
    sonarr: {
      url: process.env.SONARR_URL ?? "",
      apiKey: process.env.SONARR_API_KEY ?? "",
      qualityProfileId: process.env.SONARR_PROFILE_ID ? Number(process.env.SONARR_PROFILE_ID) : undefined,
      rootFolder: process.env.SONARR_ROOT || undefined,
    },
    auth: {
      // No default credentials — the app starts in first-run setup mode and
      // the operator chooses a username/password before anything is accessible.
      username: "",
      passwordHash: "",
      apiKeyHash: "",
      // A unique signing secret per deployment, generated on first run.
      sessionSecret: randomToken(32),
    },
  };
}

/** Fields a client is allowed to update via the settings GUI. */
export interface ConfigUpdate {
  apiKey?: string;
  country?: string;
  services?: string[];
  limit?: number;
  tmdbApiKey?: string;
  requestProvider?: "arr" | "seerr";
  seerr?: { url?: string; apiKey?: string };
  radarr?: { url?: string; apiKey?: string; qualityProfileId?: number; rootFolder?: string };
  sonarr?: { url?: string; apiKey?: string; qualityProfileId?: number; rootFolder?: string };
}

/**
 * Loads/saves AppConfig from data/config.json, seeding from env on first run.
 * Caches in memory; call load() once at startup.
 */
export class ConfigStore {
  private readonly path: string;
  private cache: AppConfig | undefined;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
  }

  async load(): Promise<AppConfig> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      // Merge over env-seeded defaults so new fields always have a value.
      this.cache = { ...seedFromEnv(), ...normalize(parsed) };
      // If the stored file lacked a valid auth block, we just generated a
      // fresh sessionSecret — persist it so it's stable across restarts.
      if (!normalize(parsed).auth) {
        await this.persist();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = seedFromEnv();
        await this.persist();
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  /** Apply a partial update from the GUI. Empty-string secrets are ignored
   *  (so saving the form without re-typing a key keeps the existing one). */
  async update(update: ConfigUpdate): Promise<AppConfig> {
    const current = await this.load();
    const next: AppConfig = {
      ...current,
      apiKey: keepSecret(current.apiKey, update.apiKey),
      country: update.country?.trim() || current.country,
      services: Array.isArray(update.services) ? update.services : current.services,
      limit:
        typeof update.limit === "number" && update.limit > 0
          ? Math.floor(update.limit)
          : current.limit,
      tmdbApiKey: keepSecret(current.tmdbApiKey, update.tmdbApiKey),
      requestProvider:
        update.requestProvider === "arr" || update.requestProvider === "seerr"
          ? update.requestProvider
          : current.requestProvider,
      seerr: mergeService(current.seerr, update.seerr),
      radarr: mergeArr(current.radarr, update.radarr),
      sonarr: mergeArr(current.sonarr, update.sonarr),
    };
    this.cache = next;
    await this.persist();
    return next;
  }

  /** The browser-safe view: secrets masked, never leaked. */
  toPublic(config: AppConfig): PublicConfig {
    return {
      country: config.country,
      services: config.services,
      limit: config.limit,
      apiKey: mask(config.apiKey),
      tmdbApiKey: mask(config.tmdbApiKey),
      requestProvider: config.requestProvider ?? "arr",
      seerr: { url: config.seerr.url, apiKey: mask(config.seerr.apiKey) },
      radarr: {
        url: config.radarr.url,
        apiKey: mask(config.radarr.apiKey),
        qualityProfileId: config.radarr.qualityProfileId,
        rootFolder: config.radarr.rootFolder,
      },
      sonarr: {
        url: config.sonarr.url,
        apiKey: mask(config.sonarr.apiKey),
        qualityProfileId: config.sonarr.qualityProfileId,
        rootFolder: config.sonarr.rootFolder,
      },
      auth: {
        username: config.auth?.username ?? "",
        apiKeySet: Boolean(config.auth?.apiKeyHash),
      },
    };
  }

  /** True before an admin account exists (first-run setup mode). */
  async needsSetup(): Promise<boolean> {
    const c = await this.load();
    return !c.auth?.username || !c.auth?.passwordHash;
  }

  /** Replace the whole auth block (used by setup / credential change). */
  async setAuth(auth: AppConfig["auth"]): Promise<void> {
    const current = await this.load();
    this.cache = { ...current, auth };
    await this.persist();
  }

  async getAuth(): Promise<AppConfig["auth"]> {
    const c = await this.load();
    return c.auth;
  }

  private async persist(): Promise<void> {
    if (!this.cache) return;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.cache, null, 2), "utf8");
  }
}

/** Keep the existing secret when the incoming value is undefined or blank. */
function keepSecret(current: string, incoming?: string): string {
  if (incoming === undefined) return current;
  const trimmed = incoming.trim();
  return trimmed === "" ? current : trimmed;
}

function mergeService(
  current: { url: string; apiKey: string },
  update?: { url?: string; apiKey?: string },
): { url: string; apiKey: string } {
  if (!update) return current;
  return {
    url: update.url !== undefined ? update.url.trim() : current.url,
    apiKey: keepSecret(current.apiKey, update.apiKey),
  };
}

/** Like mergeService, but also merges the optional quality profile + root folder. */
function mergeArr(
  current: { url: string; apiKey: string; qualityProfileId?: number; rootFolder?: string },
  update?: { url?: string; apiKey?: string; qualityProfileId?: number; rootFolder?: string },
): { url: string; apiKey: string; qualityProfileId?: number; rootFolder?: string } {
  if (!update) return current;
  return {
    url: update.url !== undefined ? update.url.trim() : current.url,
    apiKey: keepSecret(current.apiKey, update.apiKey),
    qualityProfileId:
      typeof update.qualityProfileId === "number" ? update.qualityProfileId : current.qualityProfileId,
    rootFolder: update.rootFolder !== undefined ? update.rootFolder : current.rootFolder,
  };
}

function normalize(parsed: Partial<AppConfig>): Partial<AppConfig> {
  // Defensive: ensure nested objects exist if the file was hand-edited.
  const out: Partial<AppConfig> = {
    ...parsed,
    seerr: parsed.seerr ?? undefined,
    radarr: parsed.radarr ?? undefined,
    sonarr: parsed.sonarr ?? undefined,
  };
  // Only carry an auth block through if it's complete; otherwise let the
  // env-seeded default (fresh sessionSecret, empty creds) take over so the
  // app enters first-run setup rather than loading a half-formed auth state.
  if (
    parsed.auth &&
    typeof parsed.auth.sessionSecret === "string" &&
    parsed.auth.sessionSecret.length > 0
  ) {
    out.auth = {
      username: parsed.auth.username ?? "",
      passwordHash: parsed.auth.passwordHash ?? "",
      apiKeyHash: parsed.auth.apiKeyHash ?? "",
      sessionSecret: parsed.auth.sessionSecret,
    };
  } else {
    delete out.auth; // fall back to seeded default (with a fresh secret)
  }
  return out;
}
