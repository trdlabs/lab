#!/usr/bin/env bash
# outcome-embargo-smoke.sh — post-deploy smoke check (F5a, task brief step 5).
#
# Confirms a held-out outcome fixture seeded on the DEPLOYED U6 stack (per the operator
# runbook — see docs/docker-vps.md) is NOT visible through the lab read path:
#   GET /v1/tasks/:taskId/completion-summary
# Exits non-zero if any configured "held-out marker" (the held-out outcome value and/or its
# qualification verdict) is found anywhere in the response body. Fails CLOSED on any error
# (missing fixture, unreachable endpoint, bad auth, non-200 status) — a broken smoke check
# must never read as "pass".
#
# Two invocation modes:
#   1) SMOKE_BASE_URL set   — curl that URL directly. Used by the shell-contract test harness
#      (test/outcome-embargo-smoke.test.ts) and any host with direct network access to the
#      read API.
#   2) SMOKE_BASE_URL unset — exec into the deployed ingress container via
#      `docker compose ... exec -T ingress node -e "fetch(...)"`, mirroring the existing
#      scripts/smoke.sh pattern (the read-API port is not published to the VPS host — see
#      docker-compose.vps.yml, ingress has no `ports:`).
#
# Required env:
#   SMOKE_TASK_ID          — id of a completed backtest.completed task whose payload was
#                             seeded with a held-out outcome fixture.
#   SMOKE_HELDOUT_MARKERS  — comma-separated substrings that must never appear in the
#                             response body.
#   SMOKE_READ_TOKEN       — read-API bearer token (falls back to TRADING_LAB_READ_TOKEN).
#
# Optional env (mode 2 only):
#   MODE (positional $1)   — compose overlay: vps (default) | demo | local
#   READ_API_PORT          — internal read-API port (default 3100)
#
#   Использование:
#     SMOKE_TASK_ID=<id> SMOKE_HELDOUT_MARKERS=<m1,m2> SMOKE_READ_TOKEN=<token> \
#       bash scripts/outcome-embargo-smoke.sh [vps|demo|local]
#
# Никогда не печатает секреты — diagnostics go to stderr, and the read token is never echoed.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

MODE="${1:-vps}"
TASK_ID="${SMOKE_TASK_ID:-}"
MARKERS_RAW="${SMOKE_HELDOUT_MARKERS:-}"
READ_TOKEN="${SMOKE_READ_TOKEN:-${TRADING_LAB_READ_TOKEN:-}}"
BASE_URL="${SMOKE_BASE_URL:-}"

fail() {
  echo "[outcome-embargo-smoke] FAIL: $1" >&2
  exit 1
}

[ -n "$TASK_ID" ] || fail "SMOKE_TASK_ID is required"
[ -n "$MARKERS_RAW" ] || fail "SMOKE_HELDOUT_MARKERS is required (comma-separated)"
[ -n "$READ_TOKEN" ] || fail "SMOKE_READ_TOKEN (or TRADING_LAB_READ_TOKEN) is required"

READ_PATH="/v1/tasks/${TASK_ID}/completion-summary"

# fetch_body: prints the response body to stdout on HTTP 200, otherwise prints a diagnostic
# to stderr and returns non-zero. Runs in a command-substitution subshell — `fail`'s `exit 1`
# only terminates that subshell, and the caller checks the resulting exit status.
fetch_body() {
  if [ -n "$BASE_URL" ]; then
    # Mode 1: direct HTTP (test harness / hosts with direct read-API network access).
    local tmp_body tmp_err http_code
    tmp_body="$(mktemp)"; tmp_err="$(mktemp)"
    if ! http_code="$(curl -sS --max-time 10 -o "$tmp_body" -w '%{http_code}' \
      -H "Authorization: Bearer ${READ_TOKEN}" "${BASE_URL}${READ_PATH}" 2>"$tmp_err")"; then
      cat "$tmp_err" >&2
      rm -f "$tmp_body" "$tmp_err"
      fail "curl to the read path failed"
    fi
    if [ "$http_code" != "200" ]; then
      rm -f "$tmp_body" "$tmp_err"
      fail "read path returned HTTP ${http_code} (expected 200) — cannot validate the embargo without the seeded fixture"
    fi
    cat "$tmp_body"
    rm -f "$tmp_body" "$tmp_err"
  else
    # Mode 2: exec into the deployed ingress container — the read-API port is internal-only.
    local compose port
    compose="docker compose -f docker-compose.yml -f docker-compose.${MODE}.yml --env-file .env.${MODE}"
    port="${READ_API_PORT:-3100}"
    $compose exec -T ingress node -e "
      fetch('http://localhost:${port}${READ_PATH}', { headers: { authorization: 'Bearer ${READ_TOKEN}' } })
        .then(async (r) => {
          const body = await r.text();
          if (r.status !== 200) { process.stderr.write('read path returned HTTP ' + r.status + '\n'); process.exit(1); }
          process.stdout.write(body);
        })
        .catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
    " || fail "docker compose exec against the ingress container failed"
  fi
}

if ! BODY="$(fetch_body)"; then
  exit 1
fi

IFS=',' read -r -a MARKERS <<< "$MARKERS_RAW"
LEAKED=0
for marker in "${MARKERS[@]}"; do
  [ -n "$marker" ] || continue
  if printf '%s' "$BODY" | grep -F -q -- "$marker"; then
    # The marker itself is never echoed — only its presence is reported.
    echo "[outcome-embargo-smoke] FAIL: a held-out marker was found in the deployed read-path response (value redacted)" >&2
    LEAKED=1
  fi
done

if [ "$LEAKED" -ne 0 ]; then
  exit 1
fi

echo "[outcome-embargo-smoke] PASS: no held-out marker found at ${READ_PATH} (task=${TASK_ID})"
