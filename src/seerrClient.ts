import type { FeedEntry, SeerrMediaType } from "./seerr.js";

/**
 * Overseerr / Jellyseerr media availability status.
 * https://github.com/sct/overseerr (MediaStatus enum)
 */
export const MediaStatus = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
} as const;

export interface SeerrClientOptions {
  /** Base URL, no trailing slash, e.g. https://req.example.com */
  baseUrl: string;
  apiKey: string;
  /** Request timeout in ms. Defaults to 20000. */
  timeoutMs?: number;
}

/** Minimal shape of the mediaInfo block we care about. */
interface MediaInfo {
  status?: number;
  requests?: unknown[];
}

interface MediaDetails {
  mediaInfo?: MediaInfo | null;
}

/**
 * Thin client for the subset of the Overseerr/Jellyseerr API we use:
 *  - look up a title's current status (to avoid re-requesting), and
 *  - submit a request (letting Seerr apply each backend's default
 *    quality profile and root folder).
 */
export class SeerrClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: SeerrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | undefined }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-Api-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let data: T | undefined;
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text) as T;
        } catch {
          data = undefined;
        }
      }
      return { status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Confirm the API key / instance is reachable. Throws on failure. */
  async verify(): Promise<string> {
    const { status, data } = await this.request<{ version?: string }>(
      "GET",
      "/api/v1/status",
    );
    if (status !== 200) {
      throw new Error(`Seerr /status returned HTTP ${status}`);
    }
    return data?.version ?? "unknown";
  }

  /**
   * Returns true if the title already exists in the library or has already
   * been requested — i.e. we must NOT request it again.
   *
   * A title is "existing" when Seerr has mediaInfo with a status other than
   * UNKNOWN, or when it already has one or more requests. A 404 (or no
   * mediaInfo) means Seerr doesn't track it yet -> safe to request.
   */
  async exists(entry: FeedEntry): Promise<boolean> {
    if (entry.tmdbId === undefined) {
      // No reliable id to check -> caller treats this as "cannot verify".
      // We report existing=true to stay safe (never request the unverifiable).
      return true;
    }
    const path = `/api/v1/${entry.mediaType}/${entry.tmdbId}`;
    const { status, data } = await this.request<MediaDetails>("GET", path);

    if (status === 404) return false; // not tracked by Seerr -> requestable
    if (status !== 200) {
      // Unknown/error state: be conservative and treat as existing (skip).
      throw new Error(
        `Seerr lookup ${path} returned HTTP ${status}; treating as unresolved`,
      );
    }

    const info = data?.mediaInfo;
    if (!info) return false; // known to TMDB but no media record -> requestable

    const hasRequests = Array.isArray(info.requests) && info.requests.length > 0;
    const tracked =
      typeof info.status === "number" && info.status > MediaStatus.UNKNOWN;
    return hasRequests || tracked;
  }

  /**
   * Submit a request for a title. Quality profile and root folder are
   * intentionally omitted so Seerr applies the default server's defaults
   * (Radarr for movies, Sonarr for TV).
   *
   * For TV, Seerr requires a `seasons` field. Pass "all", or an array of
   * season numbers (e.g. [1] or [2,3,4]). Defaults to [1] (season 1 only) so
   * an old multi-season show doesn't pull every season by accident.
   */
  async submitRequest(
    entry: FeedEntry,
    seasons: "all" | number[] = [1],
  ): Promise<void> {
    if (entry.tmdbId === undefined) {
      throw new Error(`Cannot request "${entry.title}" without a TMDB id`);
    }
    const body: Record<string, unknown> = {
      mediaType: entry.mediaType,
      mediaId: entry.tmdbId,
    };
    if (entry.mediaType === "tv") {
      // Guard: an empty array would be invalid; fall back to season 1.
      body.seasons = seasons === "all" ? "all" : seasons.length ? seasons : [1];
    }

    const { status, data } = await this.request<{ message?: string }>(
      "POST",
      "/api/v1/request",
      body,
    );
    if (status !== 200 && status !== 201) {
      const msg =
        (data && typeof data === "object" && "message" in data
          ? (data as { message?: string }).message
          : undefined) ?? `HTTP ${status}`;
      throw new Error(`Request for "${entry.title}" failed: ${msg}`);
    }
  }
}

export type { SeerrMediaType };
