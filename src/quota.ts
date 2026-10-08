/**
 * Captures the Streaming Availability API quota, which the API returns as
 * response headers (`x-quota-granted`, `x-quota-used`, `x-quota-reset`) on
 * every call. We read them from the requests we already make — no extra API
 * spend — and keep the latest snapshot in memory for the dashboard.
 */

export interface QuotaSnapshot {
  granted: number;
  used: number;
  resetAt: string;
  /** When we last observed these values. */
  observedAt: string;
}

let latest: QuotaSnapshot | undefined;

export function getQuota(): QuotaSnapshot | undefined {
  return latest;
}

function record(headers: Headers): void {
  const granted = Number(headers.get("x-quota-granted"));
  const used = Number(headers.get("x-quota-used"));
  const resetAt = headers.get("x-quota-reset") ?? "";
  if (Number.isFinite(granted) && Number.isFinite(used) && granted > 0) {
    latest = { granted, used, resetAt, observedAt: new Date().toISOString() };
  }
}

/**
 * A drop-in `fetch` for the streaming-availability client's Configuration.
 * Transparently records quota headers from every response.
 */
export const quotaFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input as RequestInfo, init as RequestInit);
  try {
    record(res.headers);
  } catch {
    /* never let quota capture break a request */
  }
  return res;
};
