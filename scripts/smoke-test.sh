#!/usr/bin/env sh
# toprr smoke test — confirms a running deployment responds correctly.
# Usage: ./scripts/smoke-test.sh [base-url]   (default http://localhost:9797)
set -eu

BASE="${1:-http://localhost:9797}"
fail() { echo "✗ $1"; exit 1; }

echo "Smoke-testing toprr at $BASE"

# 1) GUI shell is served.
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/" || true)
[ "$code" = "200" ] || fail "GET / returned $code (expected 200)"
echo "✓ GUI served (200)"

# 2) Public auth-status endpoint responds with JSON.
status=$(curl -fsS "$BASE/api/auth/status" || fail "GET /api/auth/status failed")
echo "$status" | grep -q "needsSetup" || fail "unexpected /api/auth/status body: $status"
echo "✓ API reachable: $status"

# 3) A protected endpoint must require auth (401) — proves the gate is active.
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/config" || true)
[ "$code" = "401" ] || fail "GET /api/config returned $code (expected 401 — auth gate)"
echo "✓ Auth gate active (/api/config -> 401 without credentials)"

# 4) Security headers present.
curl -s -D - -o /dev/null "$BASE/" | grep -qi "content-security-policy" \
  || fail "missing Content-Security-Policy header"
echo "✓ Security headers present"

echo ""
echo "All checks passed. Open $BASE to complete the first-run wizard."
