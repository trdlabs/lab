#!/usr/bin/env bash
# outcome-embargo-smoke.sh — post-deploy smoke check (F5a, task brief step 5).
#
# Two-tier design:
#   PRIMARY   generation_lane_check — execs into the deployed U6 `worker` container (the
#             process that actually calls scrubMetricsBag/sanitizeRetryFeedback before any
#             LLM call — see src/research/outcome-embargo.ts's module docstring) and runs
#             scripts/embargo-enforcement-probe.mjs FROM THE IMAGE'S OWN /app tree against
#             fixture markers. This proves the DEPLOYED artifact enforces the embargo — the
#             actual F5a/E4b readiness question. Fails CLOSED: a missing/broken deployed
#             module is a FAIL, never a skip.
#   SECONDARY read_api_canary — the original read-path HTTP check, kept as an operator-
#             surface regression canary. It intentionally hits an UNSCRUBBED surface: the
#             read API (GET /v1/tasks/:taskId/completion-summary) is OUT OF embargo scope
#             BY DESIGN — deterministic evaluators, persistence, and the read API keep full
#             holdout access and are never scrubbed (see outcome-embargo.ts). This canary
#             catches accidental read-API regressions (e.g. the operator surface starting
#             to 500 or mis-render); it is NOT embargo-enforcement coverage and must never
#             be read as such.
#
# Fails CLOSED on any error (missing fixture, unreachable endpoint, bad auth, non-200
# status, missing/broken deployed module) — a broken smoke check must never read as "pass".
#
# Required env (both checks):
#   SMOKE_TASK_ID          — id of a completed backtest.completed task whose payload was
#                             seeded with a held-out outcome fixture (read_api_canary only).
#   SMOKE_HELDOUT_MARKERS  — comma-separated substrings that must never appear in the
#                             read_api_canary response body.
#   SMOKE_READ_TOKEN       — read-API bearer token (falls back to TRADING_LAB_READ_TOKEN).
#
# Optional env:
#   MODE (positional $1)   — compose overlay / project suffix: vps (default) | demo | local.
#   READ_API_PORT          — internal read-API port (default 3100), read_api_canary only.
#   PRIMARY_MARKER          — override generation_lane_check's fixture marker.
#
# Two invocation modes for read_api_canary:
#   1) SMOKE_BASE_URL set   — curl that URL directly. Used by the shell-contract test harness
#      (test/outcome-embargo-smoke.test.ts) and any host with direct network access to the
#      read API. generation_lane_check is SKIPPED in this mode (no deployed container to
#      exec into) — its coverage comes from test/outcome-embargo-smoke.test.ts running
#      scripts/embargo-enforcement-probe.mjs directly against the local build.
#   2) SMOKE_BASE_URL unset — exec into the deployed ingress container via
#      `docker compose ... exec -T ingress node -e "fetch(...)"`, mirroring the existing
#      scripts/smoke.sh pattern (the read-API port is not published to the VPS host — see
#      docker-compose.vps.yml, ingress has no `ports:`). generation_lane_check ALWAYS runs
#      in this mode.
#
# generation_lane_check uses label-based container discovery (com.docker.compose.project /
# com.docker.compose.service), consistent with infra/scripts/unit-health.sh's
# container_id() — NOT `docker compose exec` — so it never depends on compose file
# interpolation succeeding (e.g. LAB_U6_IMAGE being resolvable).
#
#   Использование:
#     SMOKE_TASK_ID=<id> SMOKE_HELDOUT_MARKERS=<m1,m2> SMOKE_READ_TOKEN=<token> \
#       bash scripts/outcome-embargo-smoke.sh [vps|demo|local]
#
# Никогда не печатает секреты — diagnostics go to stderr, and the read token / markers are
# never echoed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

MODE="${1:-vps}"
TASK_ID="${SMOKE_TASK_ID:-}"
MARKERS_RAW="${SMOKE_HELDOUT_MARKERS:-}"
READ_TOKEN="${SMOKE_READ_TOKEN:-${TRADING_LAB_READ_TOKEN:-}}"
BASE_URL="${SMOKE_BASE_URL:-}"
PRIMARY_MARKER="${PRIMARY_MARKER:-__HELDOUT_ENFORCEMENT_PROBE_MARKER__}"
# Exported (not interpolated into any exec'd command string) so `docker compose exec -e
# READ_TOKEN` (bare, no `=value`) can forward it from THIS process's environment — the
# value never appears in the docker/compose invocation's own argv (host `ps` visibility).
export READ_TOKEN

fail() {
  echo "[outcome-embargo-smoke] FAIL: $1" >&2
  exit 1
}

[ -n "$TASK_ID" ] || fail "SMOKE_TASK_ID is required"
[ -n "$MARKERS_RAW" ] || fail "SMOKE_HELDOUT_MARKERS is required (comma-separated)"
[ -n "$READ_TOKEN" ] || fail "SMOKE_READ_TOKEN (or TRADING_LAB_READ_TOKEN) is required"

# MODE picks the compose overlay + env file (docker-compose.$MODE.yml / .env.$MODE) and the
# compose project label generation_lane_check discovers containers by — constrain it to the
# three shipped overlays so it can never name an arbitrary file path or project.
case "$MODE" in
  vps|demo|local) ;;
  *) fail "invalid mode '$MODE' (expected vps|demo|local)" ;;
esac

# TASK_ID is interpolated into a URL and — in deployed-stack mode — into the `node -e`
# program string executed inside the ingress container. Constrain it to id-safe characters
# (uuids, slugs) so it can never inject JS, quote out of the program string, or append extra
# URL path/query segments.
if ! [[ "$TASK_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
  fail "SMOKE_TASK_ID must match ^[A-Za-z0-9._-]{1,128}\$ (got an id with unsupported characters)"
fi

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
      fail "read path returned HTTP ${http_code} (expected 200) — cannot validate the read_api_canary without the seeded fixture"
    fi
    cat "$tmp_body"
    rm -f "$tmp_body" "$tmp_err"
  else
    # Mode 2: exec into the deployed ingress container — the read-API port is internal-only.
    # `-e READ_TOKEN` (bare — no `=value`) forwards the already-exported value from this
    # process's environment; it never appears in the docker compose invocation's own argv.
    local compose port
    compose="docker compose -f docker-compose.yml -f docker-compose.${MODE}.yml --env-file .env.${MODE}"
    port="${READ_API_PORT:-3100}"
    $compose exec -T -e READ_TOKEN ingress node -e "
      fetch('http://localhost:${port}${READ_PATH}', { headers: { authorization: 'Bearer ' + process.env.READ_TOKEN } })
        .then(async (r) => {
          const body = await r.text();
          if (r.status !== 200) { process.stderr.write('read path returned HTTP ' + r.status + '\n'); process.exit(1); }
          process.stdout.write(body);
        })
        .catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
    " || fail "docker compose exec against the ingress container failed"
  fi
}

# read_api_canary (SECONDARY): NOT embargo-enforcement coverage — the read API intentionally
# returns full holdout data to operators (see outcome-embargo.ts). This only catches the
# read-API operator surface regressing (unreachable, bad auth, malformed response) or, as a
# canary, an unexpected appearance of the configured markers.
read_api_canary() {
  local body leaked marker
  local -a markers
  if ! body="$(fetch_body)"; then
    exit 1
  fi

  IFS=',' read -r -a markers <<< "$MARKERS_RAW"
  leaked=0
  for marker in "${markers[@]}"; do
    [ -n "$marker" ] || continue
    if printf '%s' "$body" | grep -F -q -- "$marker"; then
      # The marker itself is never echoed — only its presence is reported.
      echo "[outcome-embargo-smoke] FAIL: read_api_canary — a configured marker was found in the read-path response (value redacted; NOT embargo-enforcement coverage — see header)" >&2
      leaked=1
    fi
  done

  if [ "$leaked" -ne 0 ]; then
    exit 1
  fi

  echo "[outcome-embargo-smoke] PASS: read_api_canary — no configured marker found at ${READ_PATH} (task=${TASK_ID})"
}

# generation_lane_check (PRIMARY): execs into the deployed worker container and runs
# scripts/embargo-enforcement-probe.mjs against the IMAGE's own copy of
# src/research/outcome-embargo.ts — proves the deployed artifact enforces the embargo.
generation_lane_check() {
  local project cid probe_path
  local -x EMBARGO_MODULE_PATH EMBARGO_MARKER

  # Label-based discovery (NOT `docker compose exec`) — consistent with
  # infra/scripts/unit-health.sh's container_id(), and does not depend on compose file
  # interpolation succeeding.
  project="trading-${MODE}"
  cid="$(docker ps -a -q \
    --filter "label=com.docker.compose.project=${project}" \
    --filter "label=com.docker.compose.service=worker" \
    2>/dev/null | head -n1 || true)"
  if [ -z "$cid" ]; then
    fail "generation_lane_check: no 'worker' container found for compose project '${project}' (label discovery — is the U6 stack up?)"
  fi

  EMBARGO_MODULE_PATH="/app/src/research/outcome-embargo.ts"
  EMBARGO_MARKER="$PRIMARY_MARKER"
  probe_path="/app/scripts/embargo-enforcement-probe.mjs"

  # `-e EMBARGO_MODULE_PATH -e EMBARGO_MARKER` (bare — no `=value`) forward the local-scoped
  # exports above; same argv-hygiene pattern as read_api_canary's READ_TOKEN handling.
  if docker exec \
      -e EMBARGO_MODULE_PATH \
      -e EMBARGO_MARKER \
      "$cid" node --experimental-transform-types "$probe_path" 1>&2; then
    echo "[outcome-embargo-smoke] PASS: generation_lane_check — deployed worker (${cid:0:12}) scrubs held-out markers"
  else
    fail "generation_lane_check: deployed generation-lane enforcement probe failed inside worker container ${cid:0:12} — embargo NOT enforced by the deployed image (or scrubMetricsBag/sanitizeRetryFeedback is missing from it)"
  fi
}

if [ -n "$BASE_URL" ]; then
  # Test-harness / direct-network mode: only the read-API canary is runnable (no deployed
  # container to exec into). generation_lane_check's coverage lives in
  # test/outcome-embargo-smoke.test.ts, run directly against the local build.
  read_api_canary
else
  # Deployed-stack mode: PRIMARY first (fail fast on real embargo breakage), then the
  # SECONDARY canary.
  generation_lane_check
  read_api_canary
fi
