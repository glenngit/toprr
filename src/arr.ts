import type { SeerrMediaType } from "./seerr.js";

export interface ArrClientOptions {
  radarrUrl?: string;
  radarrApiKey?: string;
  sonarrUrl?: string;
  sonarrApiKey?: string;
  timeoutMs?: number;
  /** How long to cache the Sonarr series index, in ms. Default 60s. */
  seriesCacheMs?: number;
}

/** Normalized library status for a single title. */
export interface TitleStatus {
  /** Present in the backend library at all. */
  inLibrary: boolean;
  monitored?: boolean;
  /** For movies: file downloaded. For TV: all available episodes present. */
  hasFile?: boolean;
  /** 0..100 — percent of (aired) episodes present (TV) or 0/100 (movies). */
  percentComplete?: number;
  /** True when the library has everything currently available for this title. */
  upToDate: boolean;
  /** Currently downloading in Radarr/Sonarr (live queue). */
  downloading?: boolean;
  /** 0..100 download progress of the active grab, when downloading. */
  downloadProgress?: number;
  // NOTE: no file sizes or paths are exposed here — library location and disk
  // usage are intentionally kept out of all status/history responses.
}

interface RadarrMovie {
  id: number;
  tmdbId: number;
  monitored: boolean;
  hasFile: boolean;
  sizeOnDisk: number;
}

interface SonarrSeries {
  id: number;
  tmdbId: number;
  monitored: boolean;
  statistics?: {
    episodeFileCount?: number;
    totalEpisodeCount?: number;
    percentOfEpisodes?: number;
    sizeOnDisk?: number;
  };
}

/**
 * Reads live status from Radarr (movies) and Sonarr (TV).
 *
 * API keys are used only here, server-side; they are never surfaced to the
 * browser. Radarr supports filtering movies by tmdbId directly; Sonarr does
 * not, so we fetch the full series list once and index it by tmdbId (cached).
 */
export class ArrClient {
  private readonly opts: Required<
    Pick<ArrClientOptions, "timeoutMs" | "seriesCacheMs">
  > &
    ArrClientOptions;
  private seriesIndex: Map<number, SonarrSeries> | undefined;
  private seriesIndexAt = 0;
  private movieIndex: Map<number, RadarrMovie> | undefined;
  private movieIndexAt = 0;

  constructor(options: ArrClientOptions) {
    this.opts = {
      timeoutMs: options.timeoutMs ?? 20_000,
      seriesCacheMs: options.seriesCacheMs ?? 60_000,
      ...options,
    };
  }

  get radarrConfigured(): boolean {
    return Boolean(this.opts.radarrUrl && this.opts.radarrApiKey);
  }
  get sonarrConfigured(): boolean {
    return Boolean(this.opts.sonarrUrl && this.opts.sonarrApiKey);
  }

  private async post<T>(base: string, apiKey: string, path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${path} -> HTTP ${res.status}${text ? ": " + text.slice(0, 200) : ""}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * List quality profiles and root folders for a backend, so the GUI can let
   * the operator choose defaults. Root-folder paths appear ONLY here (the
   * settings picker); they are never surfaced in status/history responses.
   */
  async options(kind: "radarr" | "sonarr"): Promise<{
    profiles: Array<{ id: number; name: string }>;
    rootFolders: Array<{ path: string }>;
  }> {
    const base = kind === "radarr" ? this.opts.radarrUrl : this.opts.sonarrUrl;
    const key = kind === "radarr" ? this.opts.radarrApiKey : this.opts.sonarrApiKey;
    if (!base || !key) return { profiles: [], rootFolders: [] };
    const [profiles, rootFolders] = await Promise.all([
      this.get<Array<{ id: number; name: string }>>(base, key, "/api/v3/qualityprofile"),
      this.get<Array<{ path: string }>>(base, key, "/api/v3/rootfolder"),
    ]);
    return {
      profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
      rootFolders: rootFolders.map((r) => ({ path: r.path })),
    };
  }

  /** Add a movie to Radarr by tmdb/imdb id with chosen profile + root folder. */
  async addMovie(opts: {
    tmdbId?: number;
    imdbId?: string;
    qualityProfileId: number;
    rootFolderPath: string;
    searchForMovie?: boolean;
  }): Promise<void> {
    if (!this.radarrConfigured) throw new Error("Radarr is not configured");
    const term = opts.tmdbId ? `tmdb:${opts.tmdbId}` : `imdb:${opts.imdbId}`;
    const lookup = await this.get<RadarrMovie[]>(
      this.opts.radarrUrl!,
      this.opts.radarrApiKey!,
      `/api/v3/movie/lookup?term=${encodeURIComponent(term)}`,
    );
    const found = lookup[0] as (RadarrMovie & Record<string, unknown>) | undefined;
    if (!found) throw new Error("Movie not found in Radarr lookup");
    if (found.id && found.id > 0) return; // already in library
    await this.post(this.opts.radarrUrl!, this.opts.radarrApiKey!, "/api/v3/movie", {
      ...found,
      qualityProfileId: opts.qualityProfileId,
      rootFolderPath: opts.rootFolderPath,
      monitored: true,
      addOptions: { searchForMovie: opts.searchForMovie ?? true },
    });
  }

  /** Add a series to Sonarr by tmdb/imdb id with chosen profile + root folder. */
  async addSeries(opts: {
    tmdbId?: number;
    imdbId?: string;
    qualityProfileId: number;
    rootFolderPath: string;
    seasons: "all" | number[];
    searchForMissing?: boolean;
  }): Promise<void> {
    if (!this.sonarrConfigured) throw new Error("Sonarr is not configured");
    const term = opts.imdbId ? `imdb:${opts.imdbId}` : `tmdb:${opts.tmdbId}`;
    const lookup = await this.get<Array<SonarrSeries & Record<string, unknown>>>(
      this.opts.sonarrUrl!,
      this.opts.sonarrApiKey!,
      `/api/v3/series/lookup?term=${encodeURIComponent(term)}`,
    );
    const found = lookup[0];
    if (!found) throw new Error("Series not found in Sonarr lookup");
    if (typeof found.id === "number" && found.id > 0) return; // already in library
    // Monitor the chosen seasons.
    const allSeasons = (found.seasons as Array<{ seasonNumber: number }> | undefined) ?? [];
    const seasonsPayload = allSeasons.map((s) => ({
      seasonNumber: s.seasonNumber,
      monitored:
        opts.seasons === "all"
          ? s.seasonNumber > 0
          : opts.seasons.includes(s.seasonNumber),
    }));
    await this.post(this.opts.sonarrUrl!, this.opts.sonarrApiKey!, "/api/v3/series", {
      ...found,
      qualityProfileId: opts.qualityProfileId,
      rootFolderPath: opts.rootFolderPath,
      monitored: true,
      seasons: seasonsPayload,
      addOptions: {
        searchForMissingEpisodes: opts.searchForMissing ?? true,
        monitor: opts.seasons === "all" ? "all" : "none",
      },
    });
  }

  private async get<T>(base: string, apiKey: string, path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
        headers: { "X-Api-Key": apiKey },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`${path} -> HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build TitleStatus from a Radarr movie record. */
  private movieToStatus(movie: RadarrMovie | undefined): TitleStatus {
    if (!movie) return { inLibrary: false, upToDate: false };
    return {
      inLibrary: true,
      monitored: movie.monitored,
      hasFile: movie.hasFile,
      percentComplete: movie.hasFile ? 100 : 0,
      upToDate: movie.hasFile,
    };
  }

  /** Cached index of ALL Radarr movies by tmdbId (one call, reused). */
  private async ensureMovieIndex(): Promise<Map<number, RadarrMovie>> {
    const fresh = this.movieIndex && Date.now() - this.movieIndexAt < this.opts.seriesCacheMs;
    if (fresh) return this.movieIndex!;
    const list = await this.get<RadarrMovie[]>(
      this.opts.radarrUrl!,
      this.opts.radarrApiKey!,
      "/api/v3/movie",
    );
    const index = new Map<number, RadarrMovie>();
    for (const m of list) {
      if (typeof m.tmdbId === "number" && m.tmdbId > 0) index.set(m.tmdbId, m);
    }
    this.movieIndex = index;
    this.movieIndexAt = Date.now();
    return index;
  }

  /** Movie status via Radarr (single-title filter; used for one-off lookups). */
  private async movieStatus(tmdbId: number): Promise<TitleStatus> {
    if (!this.radarrConfigured) {
      return { inLibrary: false, upToDate: false };
    }
    const movies = await this.get<RadarrMovie[]>(
      this.opts.radarrUrl!,
      this.opts.radarrApiKey!,
      `/api/v3/movie?tmdbId=${encodeURIComponent(String(tmdbId))}`,
    );
    const movie = movies[0];
    if (!movie) return { inLibrary: false, upToDate: false };
    return {
      inLibrary: true,
      monitored: movie.monitored,
      hasFile: movie.hasFile,
      percentComplete: movie.hasFile ? 100 : 0,
      upToDate: movie.hasFile,
    };
  }

  private async ensureSeriesIndex(): Promise<Map<number, SonarrSeries>> {
    const fresh =
      this.seriesIndex &&
      Date.now() - this.seriesIndexAt < this.opts.seriesCacheMs;
    if (fresh) return this.seriesIndex!;

    const list = await this.get<SonarrSeries[]>(
      this.opts.sonarrUrl!,
      this.opts.sonarrApiKey!,
      "/api/v3/series",
    );
    const index = new Map<number, SonarrSeries>();
    for (const s of list) {
      if (typeof s.tmdbId === "number" && s.tmdbId > 0) index.set(s.tmdbId, s);
    }
    this.seriesIndex = index;
    this.seriesIndexAt = Date.now();
    return index;
  }

  /** Build TitleStatus from a Sonarr series record (episode-coverage based). */
  private seriesToStatus(series: SonarrSeries | undefined): TitleStatus {
    if (!series) return { inLibrary: false, upToDate: false };
    const stats = series.statistics ?? {};
    const total = stats.totalEpisodeCount ?? 0;
    const have = stats.episodeFileCount ?? 0;
    // Sonarr's percentOfEpisodes is relative to episodes that have AIRED, so a
    // still-airing show with every aired episode reads 100%. We treat
    // "up to date" as "you have everything currently available" (100%), which
    // keeps the label consistent with the percentage and correct for ongoing
    // series. `monitoredComplete` flags whether every aired episode is present.
    const percent =
      typeof stats.percentOfEpisodes === "number"
        ? stats.percentOfEpisodes
        : total > 0
          ? (have / total) * 100
          : 0;
    const pct = Math.round(percent);
    return {
      inLibrary: true,
      monitored: series.monitored,
      hasFile: pct >= 100,
      percentComplete: pct,
      upToDate: pct >= 100,
    };
  }

  /** Series status via Sonarr (indexed by tmdbId; episode coverage based). */
  private async seriesStatus(tmdbId: number): Promise<TitleStatus> {
    if (!this.sonarrConfigured) return { inLibrary: false, upToDate: false };
    const index = await this.ensureSeriesIndex();
    return this.seriesToStatus(index.get(tmdbId));
  }

  /** Resolve live status for a title by media type + tmdbId. */
  async statusFor(
    mediaType: SeerrMediaType,
    tmdbId: number,
  ): Promise<TitleStatus> {
    return mediaType === "movie"
      ? this.movieStatus(tmdbId)
      : this.seriesStatus(tmdbId);
  }

  /**
   * Resolve status for MANY titles efficiently: fetches the Radarr movie list
   * and/or Sonarr series list at most once each (cached), then looks every
   * title up in-memory. This turns N network calls into ≤2 for a whole page.
   *
   * Returns a map keyed by "<mediaType>:<tmdbId>".
   */
  /**
   * Fetch active-download progress from a backend's queue, mapped by the
   * backend's internal id (movieId / seriesId). Progress is a percentage only
   * — no byte sizes or paths are returned. Best-effort; errors yield {}.
   */
  private async fetchQueueProgress(
    kind: "radarr" | "sonarr",
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    const base = kind === "radarr" ? this.opts.radarrUrl : this.opts.sonarrUrl;
    const key = kind === "radarr" ? this.opts.radarrApiKey : this.opts.sonarrApiKey;
    if (!base || !key) return map;
    const idField = kind === "radarr" ? "movieId" : "seriesId";
    try {
      const q = await this.get<{
        records?: Array<{ [k: string]: unknown; size?: number; sizeleft?: number }>;
      }>(base, key, `/api/v3/queue?pageSize=500`);
      for (const r of q.records ?? []) {
        const id = r[idField];
        if (typeof id !== "number") continue;
        const size = typeof r.size === "number" ? r.size : 0;
        const left = typeof r.sizeleft === "number" ? r.sizeleft : 0;
        const progress = size > 0 ? Math.round(((size - left) / size) * 100) : 0;
        // Keep the furthest-along grab if multiple queue items map to one id.
        map.set(id, Math.max(map.get(id) ?? 0, progress));
      }
    } catch {
      // ignore — activity is best-effort
    }
    return map;
  }

  async statusForMany(
    items: Array<{ mediaType: SeerrMediaType; tmdbId: number }>,
  ): Promise<Record<string, TitleStatus>> {
    const needMovies = items.some((i) => i.mediaType === "movie");
    const needSeries = items.some((i) => i.mediaType === "tv");
    const [movieIdx, seriesIdx, movieQueue, seriesQueue] = await Promise.all([
      needMovies && this.radarrConfigured ? this.ensureMovieIndex() : undefined,
      needSeries && this.sonarrConfigured ? this.ensureSeriesIndex() : undefined,
      needMovies && this.radarrConfigured ? this.fetchQueueProgress("radarr") : undefined,
      needSeries && this.sonarrConfigured ? this.fetchQueueProgress("sonarr") : undefined,
    ]);
    const out: Record<string, TitleStatus> = {};
    for (const i of items) {
      const key = `${i.mediaType}:${i.tmdbId}`;
      if (i.mediaType === "movie") {
        const movie = movieIdx?.get(i.tmdbId);
        const status = movieIdx ? this.movieToStatus(movie) : { inLibrary: false, upToDate: false };
        if (movie && movieQueue?.has(movie.id)) {
          status.downloading = true;
          status.downloadProgress = movieQueue.get(movie.id);
        }
        out[key] = status;
      } else {
        const series = seriesIdx?.get(i.tmdbId);
        const status = seriesIdx ? this.seriesToStatus(series) : { inLibrary: false, upToDate: false };
        if (series && seriesQueue?.has(series.id)) {
          status.downloading = true;
          status.downloadProgress = seriesQueue.get(series.id);
        }
        out[key] = status;
      }
    }
    return out;
  }

  /** Backend health + queue sizes for the dashboard. */
  async health(): Promise<{
    radarr: { configured: boolean; ok: boolean; queue?: number; version?: string };
    sonarr: { configured: boolean; ok: boolean; queue?: number; version?: string };
  }> {
    const radarr = { configured: this.radarrConfigured, ok: false } as {
      configured: boolean;
      ok: boolean;
      queue?: number;
      version?: string;
    };
    const sonarr = { configured: this.sonarrConfigured, ok: false } as typeof radarr;

    if (this.radarrConfigured) {
      try {
        const status = await this.get<{ version?: string }>(
          this.opts.radarrUrl!,
          this.opts.radarrApiKey!,
          "/api/v3/system/status",
        );
        const q = await this.get<{ totalRecords?: number }>(
          this.opts.radarrUrl!,
          this.opts.radarrApiKey!,
          "/api/v3/queue?pageSize=1",
        );
        radarr.ok = true;
        radarr.version = status.version;
        radarr.queue = q.totalRecords ?? 0;
      } catch {
        radarr.ok = false;
      }
    }
    if (this.sonarrConfigured) {
      try {
        const status = await this.get<{ version?: string }>(
          this.opts.sonarrUrl!,
          this.opts.sonarrApiKey!,
          "/api/v3/system/status",
        );
        const q = await this.get<{ totalRecords?: number }>(
          this.opts.sonarrUrl!,
          this.opts.sonarrApiKey!,
          "/api/v3/queue?pageSize=1",
        );
        sonarr.ok = true;
        sonarr.version = status.version;
        sonarr.queue = q.totalRecords ?? 0;
      } catch {
        sonarr.ok = false;
      }
    }
    return { radarr, sonarr };
  }
}
