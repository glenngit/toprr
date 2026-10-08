import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomToken } from "./auth.js";
import type { SeerrMediaType } from "./seerr.js";

/** One recorded request event (what toprr asked a backend to add). */
export interface HistoryRecord {
  /** Stable unique id for targeting retry/remove. Generated on append. */
  id?: string;
  /** ISO timestamp of when the request was submitted. */
  requestedAt: string;
  mediaType: SeerrMediaType;
  tmdbId: number;
  imdbId?: string;
  title: string;
  originalTitle?: string;
  year?: number;
  /** Rating 0–100 at time of request (for display). */
  rating?: number;
  /** Compact display fields for the details modal (no re-fetch needed). */
  overview?: string;
  poster?: string;
  cast?: string[];
  directors?: string[];
  creators?: string[];
  runtime?: number;
  seasonCount?: number;
  episodeCount?: number;
  /** Streaming services whose Top 10 this title appeared on. */
  services: string[];
  /** TV only: which seasons were requested ("all" or specific numbers). */
  seasons?: "all" | number[];
  /** Whether the submit succeeded. */
  ok: boolean;
  /** Error message if the submit failed. */
  error?: string;
}

interface HistoryFile {
  version: 1;
  records: HistoryRecord[];
}

const DEFAULT_PATH = "data/history.json";

/**
 * Append-oriented JSON request history, persisted to data/history.json.
 *
 * Deliberately simple (single JSON file) — history is small (tens of entries
 * per day) and only written during sync:submit. Reads are used by the web GUI.
 */
export class HistoryStore {
  private readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
  }

  async readAll(): Promise<HistoryRecord[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as HistoryFile;
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      // Backfill a stable id for legacy records written before ids existed, so
      // retry/remove can target them. Deterministic (type+tmdb+timestamp) so it
      // stays constant across reads without needing a write.
      return records.map((r) =>
        r.id ? r : { ...r, id: `${r.mediaType}-${r.tmdbId}-${r.requestedAt}`.replace(/[^A-Za-z0-9_-]/g, "") },
      );
    } catch (err) {
      // Missing file -> empty history. Other errors propagate.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async append(records: HistoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    const existing = await this.readAll();
    const withIds = records.map((r) => ({ ...r, id: r.id ?? randomToken(8) }));
    const next: HistoryFile = {
      version: 1,
      records: [...existing, ...withIds],
    };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(next, null, 2), "utf8");
  }

  /** Remove a record by id. Returns true if one was removed. */
  async remove(id: string): Promise<boolean> {
    const existing = await this.readAll();
    const next = existing.filter((r) => r.id !== id);
    if (next.length === existing.length) return false;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ version: 1, records: next }, null, 2), "utf8");
    return true;
  }

  /** Patch a record by id (e.g. after a retry). Returns the updated record. */
  async update(id: string, patch: Partial<HistoryRecord>): Promise<HistoryRecord | null> {
    const existing = await this.readAll();
    let updated: HistoryRecord | null = null;
    const next = existing.map((r) => {
      if (r.id === id) {
        updated = { ...r, ...patch, id: r.id };
        return updated;
      }
      return r;
    });
    if (!updated) return null;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ version: 1, records: next }, null, 2), "utf8");
    return updated;
  }

  /**
   * Summary stats for the GUI dashboard: totals and recent activity.
   */
  async summary(): Promise<{
    total: number;
    ok: number;
    failed: number;
    lastRequestedAt?: string;
  }> {
    const records = await this.readAll();
    const ok = records.filter((r) => r.ok).length;
    const last = records.reduce<string | undefined>((acc, r) => {
      return !acc || r.requestedAt > acc ? r.requestedAt : acc;
    }, undefined);
    return {
      total: records.length,
      ok,
      failed: records.length - ok,
      lastRequestedAt: last,
    };
  }
}
