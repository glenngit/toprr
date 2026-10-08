import {
  scrypt as scryptCb,
  randomBytes,
  timingSafeEqual,
  createHmac,
  createHash,
  type ScryptOptions,
} from "node:crypto";

// Promisified scrypt that preserves the (password, salt, keylen, options) form.
function scrypt(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, dk) =>
      err ? reject(err) : resolve(dk as Buffer),
    );
  });
}

// scrypt parameters. N=2^15 is a sensible interactive-login cost.
const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
// N*r*128 bytes ≈ 32 MiB at these params; Node's default maxmem is 32 MiB,
// so set an explicit headroom to avoid "memory limit exceeded".
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * Hash a password with scrypt. Returns a self-describing string:
 *   scrypt$N$r$p$<saltB64>$<hashB64>
 * so parameters can evolve without breaking existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = (await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Verify a password against a stored scrypt hash, in constant time.
 * Returns false for any malformed hash rather than throwing.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (!N || !r || !p || salt.length === 0 || expected.length === 0) return false;
    const derived = (await scrypt(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM })) as Buffer;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Cryptographically-random opaque token (URL-safe base64), 256-bit by default. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Generate a new API key. The plaintext is returned to show the user ONCE;
 * only its hash is persisted. Prefixed for readability (like other tools).
 */
export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = randomToken(32);
  return { plaintext, hash: hashApiKey(plaintext) };
}

/** Hash an API key at rest with SHA-256 (keys are high-entropy, so no salt needed). */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Constant-time comparison of an incoming API key against a stored hash. */
export function apiKeyMatches(incoming: string, storedHash: string): boolean {
  if (!incoming || !storedHash) return false;
  const a = Buffer.from(hashApiKey(incoming), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Sign a session id with HMAC-SHA256 so a tampered cookie is rejected without
 * a server-side lookup. Cookie value is "<sid>.<sig>".
 */
export function signSession(sid: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(sid).digest("base64url");
  return `${sid}.${sig}`;
}

/** Verify a signed session cookie; returns the sid if valid, else null. */
export function verifySignedSession(value: string, secret: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const sid = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(sid).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? sid : null;
}
