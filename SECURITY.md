# Security Overview & Audit — toprr

toprr is a self-hosted tool intended to run behind a reverse proxy, optionally
exposed to the public internet. This document records the security model, the
controls in place, the audit findings, and the operator's responsibilities.

> **No backdoors.** There are no hardcoded credentials, no default passwords,
> no hidden accounts, and no remote telemetry. All code is in this repository
> and uses only Node.js built-ins for crypto (`node:crypto`). First run starts
> in a setup state with **no** credentials until the operator creates them.

## Authentication model

Two independent mechanisms, like Sonarr/Radarr:

1. **Session login (browser).** Username + password. Passwords are hashed with
   **scrypt** (`N=32768, r=8, p=1`, 16-byte random salt, 32-byte output) and
   verified in constant time. Sessions are server-side, random 256-bit ids;
   the cookie carries only an HMAC-SHA256–signed id (`sid.sig`).
2. **API key (programmatic).** A random 256-bit key sent as `X-Api-Key`. Only a
   SHA-256 **hash** is stored; the plaintext is shown once at generation.
   Compared in constant time.

Every `/api/*` route except the public auth endpoints
(`/api/auth/status|setup|login|logout`) requires a valid session **or** API key.

## Controls in place

| Area | Control |
| --- | --- |
| Password storage | scrypt + per-password salt; constant-time verify; malformed hashes return false without throwing |
| API key storage | SHA-256 hash at rest; plaintext shown once; constant-time compare |
| Sessions | Server-side store, absolute 7-day expiry; HMAC-signed opaque cookie id; invalidated on password change |
| Cookies | `HttpOnly`, `SameSite=Strict`, `Secure` (auto-enabled unless plain-HTTP localhost), `Path=/`, `Max-Age` |
| CSRF | `SameSite=Strict` + required `X-Requested-With: toprr` header on cookie-authed mutations; API-key callers exempt |
| Brute force | Login rate limiter: 5 failures / 15 min per client IP → HTTP 429 + `Retry-After` |
| First-run | No default credentials; app refuses all protected routes until setup creates an admin |
| Security headers | CSP (`default-src 'self'`, images limited to self + `image.tmdb.org`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`, `Permissions-Policy` |
| Secrets exposure | Backend/API keys returned only as masked hints (`••••last4`); password/api-key/session material never serialized to the browser |
| Request size | Request bodies capped at 256 KiB (DoS guard) |
| Path traversal | Static file paths resolved and verified to stay within the public dir |
| Error handling | Internal errors return a generic message; no stack traces or internals leaked |
| XSS | All user/external strings HTML-escaped before DOM insertion; CSP blocks inline/external scripts |
| Dependencies | Runtime crypto uses Node built-ins only; no third-party auth/crypto libraries to audit |

## Audit findings

- **No command execution / eval.** No `eval`, `new Function`, or `child_process`
  anywhere in `src/`.
- **No secret leakage in logs.** Only non-sensitive metadata (usernames, IPs,
  counts) is logged. Passwords, API keys, and session material are never logged.
- **No secrets in API responses.** Verified `sessionSecret`, `passwordHash`, and
  `apiKeyHash` are never sent to clients.
- **Constant-time comparisons** used for passwords, API keys, and session
  signatures (`timingSafeEqual`), mitigating timing attacks.

### Verified behaviours (manual)

- Unauthenticated access to any protected route → `401`.
- First run → setup flow; after setup, session cookie grants access.
- Logout invalidates the session.
- Cookie-authed mutation without the CSRF header → `403`.
- API key: valid → `200`, invalid → `401`.
- 6 bad logins → `401 ×5` then `429`.

## Residual risks & operator responsibilities

- **Terminate TLS at your reverse proxy.** toprr speaks HTTP; run it behind a
  proxy that enforces HTTPS so the `Secure` cookie and credentials are protected
  in transit. Do not expose the raw HTTP port to the internet.
- **Trust the `X-Forwarded-For` header only from your proxy.** Rate limiting keys
  on it; a direct-to-app attacker could spoof it. Ensure only the proxy can reach
  the app port.
- **SSRF (by design, admin-scoped).** The app makes server-side calls to the
  Seerr/Radarr/Sonarr URLs *the authenticated admin configures*. These are not
  attacker-controlled. Treat the admin as trusted (it's their infrastructure).
- **First-run connection tests are unauthenticated.** `POST /api/test-connection`
  is reachable without a session **only while no admin account exists yet**
  (the first-run window), so the setup wizard can verify backends before login.
  In that brief window it could be used to probe arbitrary URLs. Complete the
  first-run setup promptly, and don't expose a not-yet-configured instance to
  untrusted networks. Once setup is done, the endpoint requires authentication.
- **Sessions are in-memory.** A restart logs everyone out. Acceptable for a
  single-instance self-hosted tool; there is no horizontal-scale session sharing.
- **`data/config.json` holds plaintext third-party API keys** (needed to call
  those services) plus password/key *hashes*. Protect the `data/` volume with
  appropriate file permissions; it is git-ignored by default.
- **Choose a strong admin password.** scrypt slows brute force but cannot save a
  trivial password.

## Reporting

Found an issue? Please report privately via the project's GitLab issue tracker
(mark as confidential) rather than a public issue.
