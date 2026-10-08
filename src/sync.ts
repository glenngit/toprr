import { buildFeed } from "./feed.js";
import { dedupeFeed, entryKey, partitionNewTitles, type FeedEntry } from "./seerr.js";
import { SeerrClient } from "./seerrClient.js";
import { ArrClient } from "./arr.js";
import { HistoryStore, type HistoryRecord } from "./history.js";
import { Logger } from "./logger.js";
import type { AppConfig } from "./config.js";

export interface SyncResult {
  uniqueCount: number;
  skippedExisting: FeedEntry[];
  /** Titles actually requested (submit mode) — empty on dry run. */
  requested: FeedEntry[];
  /** Titles that are new and would be requested (populated in both modes). */
  plan: FeedEntry[];
  failed: Array<{ entry: FeedEntry; error: string }>;
  dryRun: boolean;
  /** Which backend handled the run. */
  provider: "arr" | "seerr";
}

export interface SyncDeps {
  history?: HistoryStore;
  logger?: Logger;
}

/**
 * A request backend. toprr can target Overseerr/Jellyseerr OR add directly to
 * Radarr/Sonarr — Seerr is optional. Both implement this small interface so the
 * sync pipeline is backend-agnostic.
 */
interface RequestProvider {
  readonly kind: "arr" | "seerr";
  verify(): Promise<void>;
  /** True if the title already exists / was already requested (skip it). */
  exists(entry: FeedEntry): Promise<boolean>;
  submit(entry: FeedEntry, seasons: "all" | number[]): Promise<void>;
}

/** Build the Seerr-backed provider. */
function seerrProvider(config: AppConfig): RequestProvider {
  const seerr = new SeerrClient({ baseUrl: config.seerr.url, apiKey: config.seerr.apiKey });
  return {
    kind: "seerr",
    verify: async () => { await seerr.verify(); },
    exists: (e) => seerr.exists(e),
    submit: (e, seasons) => seerr.submitRequest(e, seasons),
  };
}

/** Build the direct Radarr/Sonarr-backed provider. */
function arrProvider(config: AppConfig): RequestProvider {
  const arr = new ArrClient({
    radarrUrl: config.radarr.url || undefined,
    radarrApiKey: config.radarr.apiKey || undefined,
    sonarrUrl: config.sonarr.url || undefined,
    sonarrApiKey: config.sonarr.apiKey || undefined,
  });
  return {
    kind: "arr",
    async verify() {
      const h = await arr.health();
      if (!h.radarr.configured && !h.sonarr.configured) {
        throw new Error("Configure Radarr and/or Sonarr, or switch the request provider to Seerr.");
      }
    },
    async exists(entry) {
      if (entry.tmdbId === undefined) return true; // can't verify -> don't request
      const st = await arr.statusFor(entry.mediaType, entry.tmdbId);
      return st.inLibrary; // already added to Radarr/Sonarr
    },
    async submit(entry, seasons) {
      if (entry.mediaType === "movie") {
        const profileId = config.radarr.qualityProfileId;
        const root = config.radarr.rootFolder;
        if (!profileId || !root) {
          throw new Error("Set a Radarr quality profile and root folder in Settings.");
        }
        await arr.addMovie({
          tmdbId: entry.tmdbId,
          imdbId: entry.imdbId,
          qualityProfileId: profileId,
          rootFolderPath: root,
        });
      } else {
        const profileId = config.sonarr.qualityProfileId;
        const root = config.sonarr.rootFolder;
        if (!profileId || !root) {
          throw new Error("Set a Sonarr quality profile and root folder in Settings.");
        }
        await arr.addSeries({
          tmdbId: entry.tmdbId,
          imdbId: entry.imdbId,
          qualityProfileId: profileId,
          rootFolderPath: root,
          seasons,
        });
      }
    },
  };
}

/**
 * Run the full feed → dedupe → "skip existing" → request pipeline using the
 * saved configuration. Backend-agnostic: targets Radarr/Sonarr directly
 * ("arr", default) or Seerr, based on config.requestProvider.
 *
 * - `submit: false` (default) is a dry run: nothing is requested.
 * - `submit: true` submits requests for genuinely new titles and records them.
 * - `only` restricts a submit to a chosen subset (entryKey list); empty = none.
 */
export async function runSync(
  config: AppConfig,
  options: {
    submit?: boolean;
    only?: string[];
    seasonsByKey?: Record<string, "all" | number[]>;
  } = {},
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const submit = options.submit ?? false;
  const seasonsByKey = options.seasonsByKey ?? {};
  const onlySet = Array.isArray(options.only) ? new Set(options.only) : undefined;
  const history = deps.history ?? new HistoryStore();
  const logger = deps.logger ?? new Logger();

  if (!config.apiKey) throw new Error("Streaming Availability API key is not configured");

  const providerKind = config.requestProvider ?? "arr";
  const provider = providerKind === "seerr" ? seerrProvider(config) : arrProvider(config);

  await logger.info("sync started", {
    submit,
    provider: providerKind,
    country: config.country,
    services: config.services,
  });

  const feed = await buildFeed({
    apiKey: config.apiKey,
    country: config.country,
    limit: config.limit,
    services: config.services,
    cacheMs: 60 * 60 * 1000,
  });

  const entries = dedupeFeed(feed);

  await provider.verify();

  const { toRequest, skippedExisting } = await partitionNewTitles(
    entries,
    (entry) => provider.exists(entry),
  );

  await logger.info("sync plan", {
    unique: entries.length,
    skippedExisting: skippedExisting.length,
    toRequest: toRequest.length,
  });

  const result: SyncResult = {
    uniqueCount: entries.length,
    skippedExisting,
    requested: [],
    plan: toRequest,
    failed: [],
    dryRun: !submit,
    provider: providerKind,
  };

  if (!submit) return result;

  const toSubmit = onlySet
    ? toRequest.filter((e) => onlySet.has(entryKey(e)))
    : toRequest;

  await logger.info("sync submitting", { selected: toSubmit.length, ofPlan: toRequest.length });

  const records: HistoryRecord[] = [];
  for (const entry of toSubmit) {
    const seasons: "all" | number[] =
      entry.mediaType === "tv" ? seasonsByKey[entryKey(entry)] ?? [1] : "all";
    const base = {
      requestedAt: new Date().toISOString(),
      mediaType: entry.mediaType,
      tmdbId: entry.tmdbId as number,
      imdbId: entry.imdbId,
      title: entry.title,
      originalTitle: entry.originalTitle,
      year: entry.year,
      rating: entry.rating,
      overview: entry.overview,
      poster: entry.poster,
      cast: entry.cast,
      directors: entry.directors,
      creators: entry.creators,
      runtime: entry.runtime,
      seasonCount: entry.seasonCount,
      episodeCount: entry.episodeCount,
      services: entry.services,
      seasons: entry.mediaType === "tv" ? seasons : undefined,
    };
    try {
      await provider.submit(entry, seasons);
      result.requested.push(entry);
      records.push({ ...base, ok: true });
      await logger.info("requested", {
        title: entry.title,
        mediaType: entry.mediaType,
        tmdbId: entry.tmdbId,
        provider: providerKind,
        seasons: entry.mediaType === "tv" ? seasons : undefined,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ entry, error });
      records.push({ ...base, ok: false, error });
      await logger.error("request failed", { title: entry.title, tmdbId: entry.tmdbId, error });
    }
  }

  await history.append(records);
  await logger.info("sync finished", {
    requested: result.requested.length,
    failed: result.failed.length,
  });

  return result;
}

/**
 * Submit a single title via the configured provider (used by history "retry").
 * Returns {ok} or {ok:false, error}. Does not touch history — the caller
 * updates the record.
 */
export async function requestOne(
  config: AppConfig,
  entry: Pick<FeedEntry, "mediaType" | "tmdbId" | "imdbId" | "title">,
  seasons: "all" | number[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const provider =
    (config.requestProvider ?? "arr") === "seerr" ? seerrProvider(config) : arrProvider(config);
  try {
    await provider.verify();
    await provider.submit(
      {
        mediaType: entry.mediaType,
        tmdbId: entry.tmdbId,
        imdbId: entry.imdbId,
        title: entry.title,
        genres: [],
        services: [],
        bestRank: 0,
      },
      seasons,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
