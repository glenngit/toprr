import * as streamingAvailability from "streaming-availability";
import { quotaFetch } from "./quota.js";

/**
 * Default streaming services, used to seed a fresh config and to supply a
 * friendly label when the API doesn't give us one. A deployable instance can
 * select any services its API key supports (discovered via the countries
 * endpoint) — these are just the sensible defaults this project started with.
 */
export const SERVICES = [
  { code: "apple", label: "Apple TV" },
  { code: "netflix", label: "Netflix" },
  { code: "prime", label: "Amazon Prime Video" },
  { code: "hbo", label: "HBO Max (Max)" },
] as const;

/** Default service codes in display order. */
export const DEFAULT_SERVICE_CODES = SERVICES.map((s) => s.code) as string[];

/** A streaming service code (e.g. "apple", "netflix"). Any API-supported id. */
export type ServiceCode = string;

/** Best-effort label for a service code, falling back to the code itself. */
export function labelForService(code: string): string {
  return SERVICES.find((s) => s.code === code)?.label ?? code;
}

/** A single, trimmed-down entry in the feed. */
export interface FeedItem {
  rank: number;
  showType: "movie" | "series";
  title: string;
  originalTitle?: string;
  year?: number;
  rating?: number;
  genres: string[];
  cast: string[];
  directors?: string[];
  creators?: string[];
  overview: string;
  runtime?: number;
  seasonCount?: number;
  episodeCount?: number;
  /** Poster image URL from the API's imageSet (vertical poster). */
  poster?: string;
  imdbId?: string;
  tmdbId?: string;
}

/** Top 10 lists for one service, split into movies and series. */
export interface ServiceFeed {
  service: ServiceCode;
  label: string;
  movies: FeedItem[];
  series: FeedItem[];
}

/** The full feed across all tracked services. */
export interface Feed {
  country: string;
  generatedAt: string;
  services: ServiceFeed[];
}

export interface BuildFeedOptions {
  apiKey: string;
  /** ISO 3166-1 alpha-2 country code. Defaults to "us". */
  country?: string;
  /** How many items to keep per list. Defaults to 10. */
  limit?: number;
  /**
   * Service codes to fetch. Defaults to {@link DEFAULT_SERVICE_CODES}.
   * Optionally pass labels to override the display name per service.
   */
  services?: Array<string | { code: string; label?: string }>;
  /**
   * Cache the result in-memory for this many milliseconds, keyed by
   * country+services+limit. 0 disables caching. Useful during testing to
   * avoid repeated Streaming Availability API calls. Default: 0.
   */
  cacheMs?: number;
}

function toFeedItems(
  shows: streamingAvailability.Show[],
  limit: number,
): FeedItem[] {
  return shows.slice(0, limit).map((show, index) => ({
    rank: index + 1,
    showType: show.showType as "movie" | "series",
    title: show.title,
    originalTitle: show.originalTitle,
    year: show.releaseYear ?? show.firstAirYear,
    rating: show.rating,
    genres: (show.genres ?? []).map((g) => g.name),
    cast: show.cast ?? [],
    directors: show.directors ?? undefined,
    creators: show.creators ?? undefined,
    overview: show.overview ?? "",
    runtime: show.runtime ?? undefined,
    seasonCount: show.seasonCount ?? undefined,
    episodeCount: show.episodeCount ?? undefined,
    // Prefer the vertical poster from the API's imageSet (no TMDB needed).
    poster: show.imageSet?.verticalPoster?.w360 ?? show.imageSet?.verticalPoster?.w240 ?? undefined,
    imdbId: show.imdbId,
    tmdbId: show.tmdbId,
  }));
}

/**
 * Build the complete Top 10 feed for every tracked service.
 *
 * This is the automatable entry point: it returns structured data that
 * downstream services can consume directly (or render as text via
 * {@link renderFeedText}).
 *
 * Top lists are determined by each streaming service itself and refreshed
 * daily by the API.
 */
interface CacheEntry {
  at: number;
  feed: Feed;
}
const feedCache = new Map<string, CacheEntry>();

function cacheKey(country: string, limit: number, codes: string[]): string {
  return `${country}|${limit}|${[...codes].sort().join(",")}`;
}

/**
 * Build the Top 10 feed, optionally served from a short-lived in-memory cache.
 *
 * When `cacheMs > 0`, a result for the same country+services+limit is reused
 * for that window instead of calling the Streaming Availability API again —
 * handy during GUI testing to conserve the monthly API quota.
 */
export async function buildFeed(options: BuildFeedOptions): Promise<Feed> {
  const country = options.country ?? "us";
  const limit = options.limit ?? 10;
  const codes = (options.services ?? DEFAULT_SERVICE_CODES).map((s) =>
    typeof s === "string" ? s : s.code,
  );
  const cacheMs = options.cacheMs ?? 0;

  if (cacheMs > 0) {
    const key = cacheKey(country, limit, codes);
    const hit = feedCache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) {
      return hit.feed;
    }
    const feed = await buildFeedUncached(options);
    feedCache.set(key, { at: Date.now(), feed });
    return feed;
  }

  return buildFeedUncached(options);
}

async function buildFeedUncached(options: BuildFeedOptions): Promise<Feed> {
  const country = options.country ?? "us";
  const limit = options.limit ?? 10;

  // Normalize the requested services into { code, label } pairs.
  const requested = options.services ?? DEFAULT_SERVICE_CODES;
  const serviceDefs = requested.map((s) =>
    typeof s === "string"
      ? { code: s, label: labelForService(s) }
      : { code: s.code, label: s.label ?? labelForService(s.code) },
  );

  const client = new streamingAvailability.Client(
    new streamingAvailability.Configuration({ apiKey: options.apiKey, fetchApi: quotaFetch }),
  );

  const services = await Promise.all(
    serviceDefs.map(async ({ code, label }): Promise<ServiceFeed> => {
      // A single (unfiltered) Top Shows call returns both movies and series
      // for the service, already ordered by rank, with up to ~10 of each.
      // We split by showType client-side instead of making a separate call
      // per type, which halves our API usage (1 call per service, not 2).
      const all = await client.showsApi.getTopShows({
        country,
        service: code,
      });

      const movies = all.filter((s) => s.showType === "movie");
      const series = all.filter((s) => s.showType === "series");

      return {
        service: code,
        label,
        movies: toFeedItems(movies, limit),
        series: toFeedItems(series, limit),
      };
    }),
  );

  return {
    country,
    generatedAt: new Date().toISOString(),
    services,
  };
}

function renderList(title: string, items: FeedItem[]): string {
  if (items.length === 0) {
    return `  ${title}\n    (no data returned)\n`;
  }
  const lines = items.map((item) => {
    const bits: string[] = [];
    if (item.year) bits.push(String(item.year));
    if (typeof item.rating === "number") bits.push(`${item.rating}/100`);
    if (item.genres.length) bits.push(item.genres.join(", "));
    const meta = bits.length ? ` — ${bits.join(" | ")}` : "";
    return `    ${String(item.rank).padStart(2, " ")}. ${item.title}${meta}`;
  });
  return `  ${title}\n${lines.join("\n")}\n`;
}

/** Render the feed as plain text (no images), suitable for logs or piping. */
export function renderFeedText(feed: Feed): string {
  const header =
    `TOP 10 MOVIES & TV SHOWS\n` +
    `Country: ${feed.country.toUpperCase()}  |  Generated: ${feed.generatedAt}\n` +
    `Data: Streaming Availability API (movieofthenight.com)\n`;

  const blocks = feed.services.map((s) => {
    return (
      `\n==================================================\n` +
      `${s.label}\n` +
      `==================================================\n` +
      renderList("Top 10 Movies", s.movies) +
      `\n` +
      renderList("Top 10 TV Shows", s.series)
    );
  });

  return header + blocks.join("\n");
}
