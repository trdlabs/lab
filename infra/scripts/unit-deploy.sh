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
# --force-recreate ingress worker`. After that recreate succeeds, LAB_U6_IMAGE is ALSO
# persisted into .env.vps itself (in place, atomically) — see persist_env_digest — so a
# later plain `docker compose up -d` or legacy script run resolves the same digest instead
# of silently rolling U6 back to the bootstrap-time value.
#
# Prints exactly one JSON object to stdout:
#   {"unit": string, "digest": string, "ok": boolean,
#    "checks": {<name>: "pass"|"fail"|"skip", "env_persist"?: "pass"|"fail"},
#    "detail"?: string}
# checks.env_persist only appears once the recreate has passed: "pass" once .env.vps
# carries the new digest, "fail" if the recreate succeeded but writing it back failed
# (ok is then false — see persist_env_digest).
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

# persist_env_digest: called ONLY after the targeted recreate has already succeeded.
# Writes $2 (the just-deployed digest) into $ENV_FILE under the $1= key, in place:
# replaces an existing "$1=..." line if present, appends a new "$1=$2" line
# (creating a trailing newline first if the file doesn't already end in one) if
# absent. Every other line is left byte-for-byte untouched — this must never touch
# any office/redis/postgres/phoenix variable.
#
# Atomic + permission-safe: cp -p the original onto a same-directory mktemp'd file
# first (this copies the original's mode/ownership/timestamps onto the temp file,
# so the replacement can never end up with looser permissions than the original —
# $ENV_FILE holds secrets), edit the copy, then mv it over the original (rename
# within the same directory/filesystem, so readers never observe a partial file).
# Returns 1 on any failure (temp-file creation, copy, edit, or rename) and leaves
# $ENV_FILE untouched; the caller decides what that means for the overall result.
persist_env_digest() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || return 1
  if ! cp -p "$ENV_FILE" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if grep -q "^${key}=" "$tmp"; then
    if ! sed -i "s|^${key}=.*|${key}=${value}|" "$tmp"; then
      rm -f "$tmp"
      return 1
    fi
  else
    if [ -s "$tmp" ] && [ -n "$(tail -c1 "$tmp")" ]; then
      printf '\n' >> "$tmp" || { rm -f "$tmp"; return 1; }
    fi
    if ! printf '%s=%s\n' "$key" "$value" >> "$tmp"; then
      rm -f "$tmp"
      return 1
    fi
  fi
  if ! mv "$tmp" "$ENV_FILE"; then
    rm -f "$tmp"
    return 1
  fi
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

# The recreate has already succeeded at this point — everything below only decides
# whether .env.vps ends up reflecting it. A persistence failure must NOT be
# swallowed: it is reported as ok:false (via fail(), which still exits non-zero) but
# the detail is explicit that the recreate itself already happened, so the operator
# doesn't mistake this for a failed deploy that can just be retried from scratch.
if persist_env_digest "LAB_U6_IMAGE" "$DIGEST"; then
  emit_json "true" "$CHECKS_SO_FAR,\"recreate\":\"pass\",\"env_persist\":\"pass\""
else
  fail "targeted recreate to $DIGEST succeeded — migrate ran and ingress/worker are running it now — but persisting LAB_U6_IMAGE into $REPO_DIR/$ENV_FILE failed, so that file still has the previous digest. Fix it manually (set LAB_U6_IMAGE=$DIGEST in $ENV_FILE) before running any legacy 'docker compose up'/compose command against this stack, or U6 will be silently recreated on the old digest." \
    "$CHECKS_SO_FAR,\"recreate\":\"pass\",\"env_persist\":\"fail\""
fi
