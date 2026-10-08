import { randomToken } from "./auth.js";

interface Session {
  sid: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * In-memory session store with sliding-window-free absolute expiry.
 *
 * Sessions are server-side: the cookie only carries an opaque signed id, so a
 * stolen-but-expired or revoked session is useless. On restart all sessions
 * are invalidated (acceptable for a single-instance self-hosted tool).
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;

  constructor(ttlMs = 7 * 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  create(): string {
    this.sweep();
    const sid = randomToken(32);
    const now = Date.now();
    this.sessions.set(sid, { sid, createdAt: now, expiresAt: now + this.ttlMs });
    return sid;
  }

  isValid(sid: string): boolean {
    const s = this.sessions.get(sid);
    if (!s) return false;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(sid);
      return false;
    }
    return true;
  }

  destroy(sid: string): void {
    this.sessions.delete(sid);
  }

  /** Invalidate every session (e.g. after a password change). */
  destroyAll(): void {
    this.sessions.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now > s.expiresAt) this.sessions.delete(sid);
    }
  }
}

/**
 * Fixed-window login rate limiter keyed by client identifier (IP). Protects
 * against password brute-forcing. Counts failures; a success resets the key.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 5, windowMs = 15 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** True if the key is currently allowed to attempt a login. */
  allowed(key: string): boolean {
    const rec = this.attempts.get(key);
    if (!rec) return true;
    if (Date.now() > rec.resetAt) {
      this.attempts.delete(key);
      return true;
    }
    return rec.count < this.max;
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const rec = this.attempts.get(key);
    if (!rec || now > rec.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      rec.count++;
    }
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  /** Seconds until the key's window resets (for Retry-After), or 0. */
  retryAfterSec(key: string): number {
    const rec = this.attempts.get(key);
    if (!rec) return 0;
    return Math.max(0, Math.ceil((rec.resetAt - Date.now()) / 1000));
  }
}
