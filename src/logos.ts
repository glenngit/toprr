import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { CountryOption } from "./countries.js";

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * Caches streaming-service logo images (dark-theme logos from the Streaming
 * Availability API's media CDN) to disk on first sight, then serves them
 * locally — so the GUI needs no repeat network calls for logos.
 *
 * Logos are mostly SVG, but some (e.g. HBO) are PNG — so we preserve each
 * logo's real file extension rather than assuming .svg. Files are stored as
 * data/service-logos/{serviceId}.{ext} and exposed at /logos/{serviceId}.
 */
export class LogoCache {
  private readonly dir: string;
  /** serviceId -> remote dark-theme image URL, learned from /countries. */
  private readonly urls = new Map<string, string>();

  constructor(dir = "data/service-logos") {
    this.dir = dir;
  }

  private safeId(serviceId: string): string {
    return serviceId.replace(/[^a-z0-9_-]/gi, "");
  }

  private extFor(url: string): string {
    const e = extname(new URL(url).pathname).toLowerCase();
    return e in CONTENT_TYPES ? e : ".svg";
  }

  /**
   * Record dark-theme logo URLs discovered from a countries response and
   * download any not yet cached. Safe to call on every /countries request —
   * already-cached logos are not re-fetched.
   */
  async primeFrom(countries: CountryOption[]): Promise<void> {
    for (const c of countries) {
      for (const s of c.services) {
        if (s.darkThemeImage && !this.urls.has(s.id)) {
          this.urls.set(s.id, s.darkThemeImage);
        }
      }
    }
    await this.downloadMissing();
  }

  /** Find an already-cached file for a service id, returning its path or null. */
  private async findCached(serviceId: string): Promise<string | null> {
    const id = this.safeId(serviceId);
    try {
      const files = await readdir(this.dir);
      const match = files.find((f) => f.replace(extname(f), "") === id);
      return match ? join(this.dir, match) : null;
    } catch {
      return null;
    }
  }

  private async downloadMissing(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await Promise.all(
      [...this.urls.entries()].map(async ([id, url]) => {
        if (await this.findCached(id)) return; // already cached, don't re-fetch
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const buf = Buffer.from(await res.arrayBuffer());
          await writeFile(join(this.dir, `${this.safeId(id)}${this.extFor(url)}`), buf);
        } catch {
          // Best-effort: a failed logo download just falls back to a chip label.
        }
      }),
    );
  }

  /** Read a cached logo from disk. Returns the bytes + content type, or null. */
  async read(serviceId: string): Promise<{ body: Buffer; contentType: string } | null> {
    const path = await this.findCached(serviceId);
    if (!path) return null;
    try {
      const body = await readFile(path);
      const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
      return { body, contentType };
    } catch {
      return null;
    }
  }
}
