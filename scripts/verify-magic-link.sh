#!/usr/bin/env bash
#
# End-to-end check of the magic-link sign-in flow (spec task 10, verification
# row 2). The adapter-level single-use property is covered by
# apps/admin-web/test/verification-token.spec.ts; this drives the real HTTP
# path, which needs a running Next server and so cannot live in `pnpm test`.
#
# Re-run this after any next-auth upgrade: it also asserts that the token
# hashing scheme still matches apps/api InvitationService, which is what makes
# API-minted invitation links consumable by Auth.js.
#
# Usage:  docker compose up -d --wait && pnpm --filter @knowledge-explorer/admin-web build
#         ./scripts/verify-magic-link.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a; . ./.env; set +a

PORT="${MAGIC_LINK_PORT:-3000}"
WORK="$(mktemp -d)"
EMAIL="magic-link-check-$(openssl rand -hex 3)@example.test"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  psql "$DATABASE_URL" -q -c "delete from verification_tokens where identifier='$EMAIL'" || true
  psql "$DATABASE_URL" -q -c "delete from sessions where user_id in (select id from users where email_address='$EMAIL')" || true
  psql "$DATABASE_URL" -q -c "delete from users where email_address='$EMAIL'" || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

psql "$DATABASE_URL" -q -c \
  "insert into users (email_address, user_role, display_name) values ('$EMAIL','admin_owner','Magic link check')"

( cd apps/admin-web && exec ./node_modules/.bin/next start -p "$PORT" ) > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
curl -s --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null "http://localhost:$PORT/signin" \
  || fail "server did not start; see $WORK/server.log"

CSRF="$(curl -s -c "$WORK/jar" "http://localhost:$PORT/api/auth/csrf" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])')"

curl -s -b "$WORK/jar" -c "$WORK/jar" -o /dev/null -X POST \
  "http://localhost:$PORT/api/auth/signin/email" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=$EMAIL" \
  --data-urlencode "callbackUrl=http://localhost:$PORT/"

URL="$(grep -o "http://localhost:$PORT/api/auth/callback/email?[^ ]*" "$WORK/server.log" | tail -1)"
[ -n "$URL" ] || fail "no sign-in link was logged"
echo "ok: sign-in link written to the log"

RAW="$(python3 -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query)["token"][0])' "$URL")"
STORED="$(psql "$DATABASE_URL" -tAc "select token from verification_tokens where identifier='$EMAIL'" | tr -d '[:space:]')"
[ "$RAW" != "$STORED" ] || fail "the emailed token was stored verbatim; it must be hashed"
echo "ok: only the hash is stored"

MINE="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(f"{sys.argv[1]}{sys.argv[2]}".encode()).hexdigest())' "$RAW" "$AUTH_SECRET")"
[ "$MINE" = "$STORED" ] || fail "hash scheme drift: InvitationService mints links Auth.js cannot consume"
echo "ok: hashing matches apps/api InvitationService"

curl -s -b "$WORK/jar" -c "$WORK/jar" -o /dev/null "$URL"
COUNT="$(psql "$DATABASE_URL" -tAc "select count(*) from sessions s join users u on u.id=s.user_id where u.email_address='$EMAIL'" | tr -d '[:space:]')"
[ "$COUNT" = "1" ] || fail "expected exactly 1 session after first use, found $COUNT"
echo "ok: first use created a session"

curl -s -b "$WORK/jar2" -c "$WORK/jar2" -o /dev/null "$URL"
COUNT_AFTER="$(psql "$DATABASE_URL" -tAc "select count(*) from sessions s join users u on u.id=s.user_id where u.email_address='$EMAIL'" | tr -d '[:space:]')"
[ "$COUNT_AFTER" = "1" ] || fail "reusing the link created another session ($COUNT_AFTER total)"
echo "ok: reuse rejected, no second session"

echo "PASS: magic-link flow verified end to end"
