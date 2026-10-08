import type { SeerrMediaType } from "./seerr.js";

/** Useful per-title metadata resolved from TMDB. */
export interface TmdbDetails {
  poster: string | null;
  /** TMDB user score 0–10 (one decimal). */
  voteAverage?: number;
  voteCount?: number;
  /** ISO 639-1 original language code (e.g. "en", "ja"). */
  originalLanguage?: string;
  overview?: string;
  /** TV only. */
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  /** TV only: per-season info (excludes season 0 / specials). */
  seasons?: Array<{ seasonNumber: number; name: string; episodeCount: number; airDate?: string }>;
  /** Movie only (minutes). */
  runtime?: number;
}

/**
 * Resolves metadata and poster images from TMDB for a given media type +
 * tmdbId. Images come from TMDB's CDN (no auth); the detail lookup needs a
 * TMDB v3 API key. Results are cached in-memory per process.
 */
export class TmdbClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, TmdbDetails | null>();

  constructor(apiKey: string, timeoutMs = 15_000) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * TMDB offers two credentials on the same Settings → API page:
   *  - v3 "API Key" (short, 32-char hex) → sent as `?api_key=`
   *  - v4 "API Read Access Token" (a long `eyJ…` JWT) → sent as a Bearer header
   * Accept either: detect a JWT (two dots / `eyJ` prefix) and pick the right
   * auth so the user can paste whichever value TMDB shows them.
   */
  private isV4Token(): boolean {
    return this.apiKey.startsWith("eyJ") || this.apiKey.split(".").length === 3;
  }
  /** Build the request URL + headers for a given `/3/...` path (sans query). */
  private authFor(url: string): { url: string; headers: Record<string, string> } {
    if (this.isV4Token()) {
      return { url, headers: { Authorization: `Bearer ${this.apiKey}`, accept: "application/json" } };
    }
    const sep = url.includes("?") ? "&" : "?";
    return { url: `${url}${sep}api_key=${encodeURIComponent(this.apiKey)}`, headers: {} };
  }

  private posterUrl(
    path: string | null | undefined,
    size: "w92" | "w154" | "w185" | "w342" = "w154",
  ): string | null {
    return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
  }

  /** Fetch (and cache) full details for one title. */
  async detailsFor(
    mediaType: SeerrMediaType,
    tmdbId: number,
  ): Promise<TmdbDetails | null> {
    if (!this.apiKey) return null;
    const key = `${mediaType}:${tmdbId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const kind = mediaType === "tv" ? "tv" : "movie";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const req = this.authFor(`https://api.themoviedb.org/3/${kind}/${tmdbId}`);
      const res = await fetch(req.url, { headers: req.headers, signal: controller.signal });
      if (!res.ok) {
        this.cache.set(key, null);
        return null;
      }
      const d = (await res.json()) as Record<string, unknown>;
      const details: TmdbDetails = {
        poster: this.posterUrl(d.poster_path as string | null),
        voteAverage:
          typeof d.vote_average === "number"
            ? Math.round((d.vote_average as number) * 10) / 10
            : undefined,
        voteCount: typeof d.vote_count === "number" ? (d.vote_count as number) : undefined,
        originalLanguage: (d.original_language as string) || undefined,
        overview: (d.overview as string) || undefined,
        numberOfSeasons:
          typeof d.number_of_seasons === "number" ? (d.number_of_seasons as number) : undefined,
        numberOfEpisodes:
          typeof d.number_of_episodes === "number" ? (d.number_of_episodes as number) : undefined,
        seasons: Array.isArray(d.seasons)
          ? (d.seasons as Array<Record<string, unknown>>)
              .filter((s) => typeof s.season_number === "number" && (s.season_number as number) > 0)
              .map((s) => ({
                seasonNumber: s.season_number as number,
                name: (s.name as string) || `Season ${s.season_number}`,
                episodeCount: typeof s.episode_count === "number" ? (s.episode_count as number) : 0,
                airDate: (s.air_date as string) || undefined,
              }))
          : undefined,
        runtime: typeof d.runtime === "number" ? (d.runtime as number) : undefined,
      };
      this.cache.set(key, details);
      return details;
    } catch {
      return null; // don't cache transient failures
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve details for many entries in parallel; returns a
   * "<mediaType>:<tmdbId>" -> TmdbDetails map (only successful lookups).
   */
  async detailsForMany(
    entries: Array<{ mediaType: SeerrMediaType; tmdbId?: number }>,
  ): Promise<Record<string, TmdbDetails>> {
    const out: Record<string, TmdbDetails> = {};
    if (!this.apiKey) return out;
    await Promise.all(
      entries.map(async (e) => {
        if (e.tmdbId === undefined) return;
        const details = await this.detailsFor(e.mediaType, e.tmdbId);
        if (details) out[`${e.mediaType}:${e.tmdbId}`] = details;
      }),
    );
    return out;
  }
}
