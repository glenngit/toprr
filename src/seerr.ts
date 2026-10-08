import type { Feed, FeedItem, ServiceCode } from "./feed.js";

/**
 * Overseerr / Jellyseerr media type. The Streaming Availability API uses
 * "movie" / "series"; Seerr uses "movie" / "tv".
 */
export type SeerrMediaType = "movie" | "tv";

/**
 * A single de-duplicated title ready to be considered for a Seerr request.
 *
 * `tmdbId` is the numeric TMDB id (Seerr's `mediaId`), extracted from the
 * Streaming Availability API's prefixed form (e.g. "movie/603" -> 603).
 */
export interface FeedEntry {
  mediaType: SeerrMediaType;
  tmdbId?: number;
  imdbId?: string;
  title: string;
  originalTitle?: string;
  year?: number;
  rating?: number;
  genres: string[];
  /** Rich display fields carried from the feed (no extra API calls). */
  cast?: string[];
  directors?: string[];
  creators?: string[];
  overview?: string;
  runtime?: number;
  seasonCount?: number;
  episodeCount?: number;
  poster?: string;
  /** Services whose Top 10 this title appeared on (deduped union). */
  services: ServiceCode[];
  /** Best (lowest) rank the title achieved across all lists it appeared in. */
  bestRank: number;
  /** True only if every appearance was an *upcoming* (not-yet-streaming) one. */
  upcoming?: boolean;
  /** Earliest announced availability date (Unix seconds), when known. */
  availableAt?: number;
}

/**
 * Stable key for a feed entry, used to select a subset of titles to request
 * from the GUI. Format: "<mediaType>:<tmdbId>" (e.g. "movie/603" -> "movie:603").
 */
export function entryKey(entry: Pick<FeedEntry, "mediaType" | "tmdbId">): string {
  return `${entry.mediaType}:${entry.tmdbId ?? "?"}`;
}

/** Map the API's showType to Seerr's mediaType. */
function toSeerrMediaType(showType: FeedItem["showType"]): SeerrMediaType {
  return showType === "series" ? "tv" : "movie";
}

/**
 * The Streaming Availability API returns tmdbId as a prefixed string like
 * "movie/603" or "tv/1396". Seerr needs the bare numeric id. Returns
 * undefined if the id is missing or not parseable.
 */
export function parseTmdbId(tmdbId?: string): number | undefined {
  if (!tmdbId) return undefined;
  const numeric = tmdbId.includes("/") ? tmdbId.split("/").pop() : tmdbId;
  const n = Number(numeric);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Build a stable identity key for a title so we can dedupe across services
 * and across the movie/series lists.
 *
 * Prefers "<mediaType>:tmdb:<id>", falls back to imdb id, then to a
 * normalized title+year. The mediaType is included so a movie and a series
 * that happen to share an id space never collide.
 */
function identityKey(entry: {
  mediaType: SeerrMediaType;
  tmdbId?: number;
  imdbId?: string;
  title: string;
  year?: number;
}): string {
  if (entry.tmdbId !== undefined) return `${entry.mediaType}:tmdb:${entry.tmdbId}`;
  if (entry.imdbId) return `${entry.mediaType}:imdb:${entry.imdbId}`;
  const title = entry.title.trim().toLowerCase();
  return `${entry.mediaType}:title:${title}:${entry.year ?? "?"}`;
}

/**
 * Flatten a feed into a single de-duplicated list of unique titles.
 *
 * A title appearing on multiple services (or in both a movie and series list,
 * which should not happen but is handled defensively) is collapsed into one
 * entry. We record every service it appeared on and keep its best rank.
 *
 * Output is ordered by bestRank ascending, then title, for stable, readable
 * results. This is the "final feeding list" before the already-exists filter.
 */
export function dedupeFeed(feed: Feed): FeedEntry[] {
  const byKey = new Map<string, FeedEntry>();

  const consider = (item: FeedItem, service: ServiceCode): void => {
    const mediaType = toSeerrMediaType(item.showType);
    const tmdbId = parseTmdbId(item.tmdbId);
    const base = {
      mediaType,
      tmdbId,
      imdbId: item.imdbId,
      title: item.title,
      year: item.year,
    };
    const key = identityKey(base);

    const existing = byKey.get(key);
    if (existing) {
      if (!existing.services.includes(service)) existing.services.push(service);
      existing.bestRank = Math.min(existing.bestRank, item.rank);
      // A title is only "upcoming" if EVERY appearance is upcoming. A real
      // (currently-streaming) appearance clears the flag.
      if (!item.upcoming) existing.upcoming = false;
      if (item.upcoming && item.availableAt !== undefined) {
        existing.availableAt =
          existing.availableAt === undefined
            ? item.availableAt
            : Math.min(existing.availableAt, item.availableAt);
      }
      // Keep the first-seen details; they describe the same title.
      return;
    }

    byKey.set(key, {
      ...base,
      originalTitle: item.originalTitle,
      rating: item.rating,
      genres: item.genres,
      cast: item.cast,
      directors: item.directors,
      creators: item.creators,
      overview: item.overview,
      runtime: item.runtime,
      seasonCount: item.seasonCount,
      episodeCount: item.episodeCount,
      poster: item.poster,
      services: [service],
      bestRank: item.rank,
      upcoming: item.upcoming === true,
      availableAt: item.upcoming ? item.availableAt : undefined,
    });
  };

  for (const svc of feed.services) {
    for (const movie of svc.movies) consider(movie, svc.service);
    for (const series of svc.series) consider(series, svc.service);
    for (const up of svc.upcoming ?? []) consider(up, svc.service);
  }

  return [...byKey.values()].sort(
    (a, b) =>
      Number(a.upcoming ?? false) - Number(b.upcoming ?? false) ||
      a.bestRank - b.bestRank ||
      a.title.localeCompare(b.title),
  );
}

/**
 * Predicate deciding whether a title already exists downstream (in your Seerr
 * library or already requested) and therefore must NOT be requested again.
 *
 * This is intentionally abstract: the Seerr-backed implementation will be
 * injected later. Returning `true` means "already exists — skip it".
 */
export type ExistsCheck = (entry: FeedEntry) => boolean | Promise<boolean>;

export interface FilterResult {
  /** Titles that are new and safe to request. */
  toRequest: FeedEntry[];
  /** Titles skipped because they already exist / were already requested. */
  skippedExisting: FeedEntry[];
}

/**
 * Partition the deduped feed into titles to request vs titles to skip, using
 * the injected existence check. Nothing that already exists is ever returned
 * in `toRequest` — this is the hard guarantee the caller relies on.
 *
 * Entries with no resolvable identity for the downstream system (no tmdbId)
 * are treated conservatively: by default they are skipped from `toRequest`,
 * because we cannot safely confirm they don't already exist. Set
 * `requireTmdbId: false` to include them anyway (not recommended for Seerr).
 */
export async function partitionNewTitles(
  entries: FeedEntry[],
  exists: ExistsCheck,
  options: { requireTmdbId?: boolean } = {},
): Promise<FilterResult> {
  const requireTmdbId = options.requireTmdbId ?? true;
  const toRequest: FeedEntry[] = [];
  const skippedExisting: FeedEntry[] = [];

  for (const entry of entries) {
    if (requireTmdbId && entry.tmdbId === undefined) {
      // Can't verify existence reliably -> be safe, don't request.
      skippedExisting.push(entry);
      continue;
    }
    const alreadyExists = await exists(entry);
    if (alreadyExists) {
      skippedExisting.push(entry);
    } else {
      toRequest.push(entry);
    }
  }

  return { toRequest, skippedExisting };
}

/** Render the final feeding list as plain text. */
export function renderFeedEntriesText(
  entries: FeedEntry[],
  heading = "FINAL FEEDING LIST (deduplicated)",
): string {
  const header = `${heading}\n${"=".repeat(heading.length)}\n`;
  if (entries.length === 0) return `${header}(empty)\n`;
  const lines = entries.map((e, i) => {
    const bits: string[] = [];
    if (e.year) bits.push(String(e.year));
    if (typeof e.rating === "number") bits.push(`${e.rating}/100`);
    bits.push(e.mediaType);
    if (e.tmdbId !== undefined) bits.push(`tmdb:${e.tmdbId}`);
    bits.push(`on: ${e.services.join(", ")}`);
    return `  ${String(i + 1).padStart(2, " ")}. ${e.title} — ${bits.join(" | ")}`;
  });
  return `${header}${lines.join("\n")}\n`;
}
