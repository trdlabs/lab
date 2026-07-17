#!/usr/bin/env bash
# unit-deploy.sh — digest-pinned deploy primitive for lab unit U6 (migrate + ingress +
# worker), feature F5a. Mirrors ../platform/infra/scripts/unit-deploy.sh's command
# contract and JSON-escaping/digest-validation approach exactly.
#
# U6 is the minimal, immutable lab artifact set: migrate/ingress/worker share ONE
# digest-pinned image (LAB_U6_IMAGE). Office (office-web/office-server) is NEVER part of
# U6 and is NEVER touched by this script — the VPS compose invocations below deliberately
# omit `--profile office` (see docker-compose.vps.yml's `profiles: ["office"]` guard).
# redis / lab-pg (postgres) / phoenix are infra images and stay pinned as-is — this script
# never recreates them and never runs `docker compose down -v`.
#
# Sequence: pull the shared digest -> run `migrate` to completion (one-shot, must exit 0
# before ingress/worker start against the new schema) -> targeted `up -d --no-deps
# --force-recreate ingress worker`.
#
# Prints exactly one JSON object to stdout:
#   {"unit": string, "digest": string, "ok": boolean,
#    "checks": {<name>: "pass"|"fail"|"skip"}, "detail"?: string}
# Never prints secrets (diagnostics go to stderr).
#
#   Usage:
#     bash infra/scripts/unit-deploy.sh --env <vps_staging|vps_production> \
#       --unit U6 --digest <image@sha256:...> --deploy-id <uuid>
set -euo pipefail

# Compose files live at the repo root, two levels up from this script.
# LAB_REPO_DIR is an override for the shell-contract test (test-unit-primitives.sh), which
# points this at a throwaway fixture directory instead of the real checkout.
REPO_DIR="${LAB_REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$REPO_DIR"

COMPOSE_FILE="docker-compose.vps.yml"
BASE_FILE="docker-compose.yml"
ENV_FILE=".env.vps"

ENVNAME=""
UNIT=""
DIGEST=""
DEPLOY_ID=""

# json_escape: pure-bash JSON string escaping (no jq dependency — jq may be absent on the
# VPS). Escapes backslash and double-quote, maps newline/tab/CR to \n/\t/\r, and strips any
# other C0/DEL control bytes. Every value interpolated into an emitted JSON string MUST be
# routed through this — rejection-path values (unit/digest/detail) echo back caller input
# before it has been validated, so a value containing '"', '\', or control characters must
# never be able to produce malformed JSON.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s="$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\037\177')"
  printf '%s' "$s"
}

emit_json() {
  # $1=ok(true|false) $2=checks-json-fragment $3=detail(optional)
  local unit_esc digest_esc
  unit_esc="$(json_escape "$UNIT")"
  digest_esc="$(json_escape "$DIGEST")"
  if [ -n "${3:-}" ]; then
    local detail_esc
    detail_esc="$(json_escape "$3")"
    printf '{"unit":"%s","digest":"%s","ok":%s,"checks":{%s},"detail":"%s"}\n' \
      "$unit_esc" "$digest_esc" "$1" "$2" "$detail_esc"
  else
    printf '{"unit":"%s","digest":"%s","ok":%s,"checks":{%s}}\n' \
      "$unit_esc" "$digest_esc" "$1" "$2"
  fi
}

fail() {
  # $1=detail $2=checks-json-fragment (optional, defaults to empty)
  emit_json "false" "${2:-}" "$1"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      [ $# -ge 2 ] || fail "missing value for --env"
      ENVNAME="$2"; shift 2 ;;
    --unit)
      [ $# -ge 2 ] || fail "missing value for --unit"
      UNIT="$2"; shift 2 ;;
    --digest)
      [ $# -ge 2 ] || fail "missing value for --digest"
      DIGEST="$2"; shift 2 ;;
    --deploy-id)
      [ $# -ge 2 ] || fail "missing value for --deploy-id"
      DEPLOY_ID="$2"; shift 2 ;;
    *)
      fail "unknown argument '$1'" ;;
  esac
done

[ -n "$ENVNAME" ] || fail "missing --env"
[ -n "$UNIT" ] || fail "missing --unit"
[ -n "$DIGEST" ] || fail "missing --digest"
[ -n "$DEPLOY_ID" ] || fail "missing --deploy-id"

case "$ENVNAME" in
  vps_staging|vps_production) ;;
  *) fail "invalid --env '$ENVNAME' (expected vps_staging|vps_production)" ;;
esac

# F5a implements the U6 primitive only; office is never a valid target for this command
# (design invariant — U6 = migrate/ingress/worker only, office is excluded entirely).
if [ "$UNIT" != "U6" ]; then
  fail "unsupported --unit '$UNIT' (only U6 is implemented by unit-deploy.sh)"
fi

if ! [[ "$DIGEST" =~ ^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
  fail "--digest must be a repository@sha256:<64 lowercase hex> reference only (tags, combined repo:tag@sha256:... refs, uppercase hex, and embedded whitespace/newlines are rejected): '$DIGEST'"
fi

if [ ! -f "$ENV_FILE" ]; then
  fail "$REPO_DIR/$ENV_FILE not found — bootstrap the VPS stack first (see docs/docker-vps.md)"
fi

# Deliberately NO --profile office: U6 never starts, stops, or recreates office-web /
# office-server. Only LAB_U6_IMAGE is overridden for this invocation (shell env takes
# precedence over --env-file); every other .env.vps variable (office ports/tokens, phoenix,
# etc.) is untouched.
dc() { docker compose -f "$BASE_FILE" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
export LAB_U6_IMAGE="$DIGEST"

PULL_CHECK="skip"
MIGRATE_CHECK="skip"

echo "[unit-deploy] deploy-id=$DEPLOY_ID unit=U6 (1/3) pull migrate ingress worker..." >&2
if dc pull migrate ingress worker >&2; then
  PULL_CHECK="pass"
else
  fail "docker compose pull failed" "\"pull\":\"fail\",\"migrate\":\"skip\",\"recreate\":\"skip\""
fi

# migrate is a one-shot (restart: "no") service — `up` (no -d) runs it to completion and
# returns its exit code, so a failed migration aborts BEFORE ingress/worker ever start
# against a half-migrated schema.
echo "[unit-deploy] (2/3) up --no-deps --force-recreate migrate (run-to-completion)..." >&2
if dc up --no-deps --force-recreate migrate >&2; then
  MIGRATE_CHECK="pass"
else
  fail "migrate failed" "\"pull\":\"pass\",\"migrate\":\"fail\",\"recreate\":\"skip\""
fi

CHECKS_SO_FAR="\"pull\":\"$PULL_CHECK\",\"migrate\":\"$MIGRATE_CHECK\""

echo "[unit-deploy] (3/3) targeted recreate: up -d --no-deps --force-recreate ingress worker..." >&2
if ! dc up -d --no-deps --force-recreate ingress worker >&2; then
  fail "docker compose up --force-recreate failed" "$CHECKS_SO_FAR,\"recreate\":\"fail\""
fi

echo "[unit-deploy] DONE: unit=U6 deploy-id=$DEPLOY_ID digest applied to migrate+ingress+worker." >&2
emit_json "true" "$CHECKS_SO_FAR,\"recreate\":\"pass\""
