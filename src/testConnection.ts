import * as streamingAvailability from "streaming-availability";

export type TestKind = "streaming" | "radarr" | "sonarr" | "seerr" | "tmdb";

export interface TestResult {
  ok: boolean;
  /** Human-readable detail (version, or an error message). */
  message: string;
  /** For radarr/sonarr: available quality profiles + root folders to pick from. */
  profiles?: Array<{ id: number; name: string }>;
  rootFolders?: Array<{ path: string }>;
}

const TIMEOUT = 15_000;

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    let data: unknown;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function normBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Verify that a URL + API key is reachable and valid, WITHOUT persisting
 * anything. Used by the first-run wizard and Settings to give immediate
 * feedback. For Radarr/Sonarr it also returns the quality profiles and root
 * folders so the operator can pick defaults in the same step.
 */
export async function testConnection(
  kind: TestKind,
  url: string,
  apiKey: string,
): Promise<TestResult> {
  try {
    if (kind === "streaming") {
      // Validate the Streaming Availability key via the countries endpoint.
      const client = new streamingAvailability.Client(
        new streamingAvailability.Configuration({ apiKey }),
      );
      const countries = await client.countriesApi.getCountries();
      const n = Object.keys(countries).length;
      if (n === 0) return { ok: false, message: "Key accepted but no countries returned." };
      return { ok: true, message: `Valid — ${n} countries available.` };
    }

    if (kind === "tmdb") {
      // Accept either a v3 key (?api_key=) or a v4 Read Access Token (Bearer).
      const isV4 = apiKey.startsWith("eyJ") || apiKey.split(".").length === 3;
      const { status } = isV4
        ? await getJson("https://api.themoviedb.org/3/configuration", {
            Authorization: `Bearer ${apiKey}`,
          })
        : await getJson(
            `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`,
            {},
          );
      if (status === 200) return { ok: true, message: `Valid TMDB ${isV4 ? "v4 token" : "key"}.` };
      if (status === 401) return { ok: false, message: "Invalid TMDB API key / token." };
      return { ok: false, message: `TMDB returned HTTP ${status}.` };
    }

    const base = normBase(url);
    if (!base) return { ok: false, message: "URL is required." };

    if (kind === "radarr" || kind === "sonarr") {
      const h = { "X-Api-Key": apiKey };
      const status = await getJson(`${base}/api/v3/system/status`, h);
      if (status.status === 401) return { ok: false, message: "Invalid API key." };
      if (status.status !== 200) {
        return { ok: false, message: `Not reachable (HTTP ${status.status}).` };
      }
      const version = (status.data as { version?: string } | undefined)?.version ?? "unknown";
      // Fetch pickable options so the wizard can set defaults in one step.
      const [prof, roots] = await Promise.all([
        getJson(`${base}/api/v3/qualityprofile`, h),
        getJson(`${base}/api/v3/rootfolder`, h),
      ]);
      const profiles = Array.isArray(prof.data)
        ? (prof.data as Array<{ id: number; name: string }>).map((p) => ({ id: p.id, name: p.name }))
        : [];
      const rootFolders = Array.isArray(roots.data)
        ? (roots.data as Array<{ path: string }>).map((r) => ({ path: r.path }))
        : [];
      return {
        ok: true,
        message: `Connected — ${kind === "radarr" ? "Radarr" : "Sonarr"} v${version}.`,
        profiles,
        rootFolders,
      };
    }

    if (kind === "seerr") {
      const { status, data } = await getJson(`${base}/api/v1/status`, { "X-Api-Key": apiKey });
      if (status === 403 || status === 401) return { ok: false, message: "Invalid API key." };
      if (status !== 200) return { ok: false, message: `Not reachable (HTTP ${status}).` };
      const version = (data as { version?: string } | undefined)?.version ?? "unknown";
      return { ok: true, message: `Connected — Seerr v${version}.` };
    }

    return { ok: false, message: "Unknown connection type." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Common, friendly messages for the usual failures.
    if (/abort/i.test(msg)) return { ok: false, message: "Timed out — check the URL and that the service is reachable." };
    return { ok: false, message: msg.slice(0, 200) };
  }
}
