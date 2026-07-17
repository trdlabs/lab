#!/usr/bin/env bash
# unit-health.sh — health primitive for lab unit U6 (migrate + ingress + worker),
# feature F5a. Checks:
#   1) ingress: read-API /healthz AND /readyz (both live on the SAME ingress container,
#      port 3100 — see src/ingress/server.ts / scripts/smoke.sh, which uses the identical
#      docker exec + node fetch pattern; the read-API port is never published to the host).
#   2) worker: container running.
#   3) migrate: the one-shot (restart: "no") container's last run exited 0 — "migration
#      completion" per the F5a brief.
#
# Container discovery uses `docker ps`/`docker inspect` filtered by the compose
# project/service labels directly (NOT `docker compose ps`/`exec`), so this read-only
# check never depends on the deploy-time LAB_U6_IMAGE variable being resolvable — a health
# check must not fail just because the compose file's required interpolation can't
# resolve (e.g. mid-provision, before .env.vps is fully populated).
#
# Prints exactly one JSON object to stdout:
#   {"unit": string, "digest": string, "ok": boolean,
#    "checks": {<name>: "pass"|"fail"|"skip"}, "detail"?: string}
# Never prints secrets.
#
#   Usage:
#     bash infra/scripts/unit-health.sh --env <vps_staging|vps_production> \
#       --unit U6 --deploy-id <uuid>
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

PROJECT_NAME="trading-vps"

ENVNAME=""
UNIT=""
DEPLOY_ID=""
DIGEST=""

# json_escape: pure-bash JSON string escaping (no jq dependency — jq may be absent on the
# VPS). Escapes backslash and double-quote, maps newline/tab/CR to \n/\t/\r, and strips any
# other C0/DEL control bytes. Every value interpolated into an emitted JSON string MUST be
# routed through this.
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

emit_fail_json() {
  # $1=detail
  local unit_esc digest_esc detail_esc
  unit_esc="$(json_escape "$UNIT")"
  digest_esc="$(json_escape "$DIGEST")"
  detail_esc="$(json_escape "$1")"
  printf '{"unit":"%s","digest":"%s","ok":false,"checks":{},"detail":"%s"}\n' \
    "$unit_esc" "$digest_esc" "$detail_esc"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      [ $# -ge 2 ] || emit_fail_json "missing value for --env"
      ENVNAME="$2"; shift 2 ;;
    --unit)
      [ $# -ge 2 ] || emit_fail_json "missing value for --unit"
      UNIT="$2"; shift 2 ;;
    --deploy-id)
      [ $# -ge 2 ] || emit_fail_json "missing value for --deploy-id"
      DEPLOY_ID="$2"; shift 2 ;;
    *)
      emit_fail_json "unknown argument '$1'" ;;
  esac
done

[ -n "$ENVNAME" ] || emit_fail_json "missing --env"
[ -n "$UNIT" ] || emit_fail_json "missing --unit"
[ -n "$DEPLOY_ID" ] || emit_fail_json "missing --deploy-id"

case "$ENVNAME" in
  vps_staging|vps_production) ;;
  *) emit_fail_json "invalid --env '$ENVNAME' (expected vps_staging|vps_production)" ;;
esac

if [ "$UNIT" != "U6" ]; then
  emit_fail_json "unsupported --unit '$UNIT' (only U6 is implemented by unit-health.sh)"
fi

container_id() {
  # $1=service name -> prints container id, or empty if not found/docker unreachable.
  # `-a` includes exited containers — required for the migrate one-shot check below.
  docker ps -a -q \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1" \
    2>/dev/null | head -n1 || true
}

running_status() {
  # $1=service name -> "pass" | "fail" (healthy/running is pass; anything else is fail).
  local cid status
  cid="$(container_id "$1")"
  if [ -z "$cid" ]; then
    echo "fail"
    return
  fi
  status="$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{if .State.Running}}running{{else}}stopped{{end}}{{end}}' \
    "$cid" 2>/dev/null || echo "unknown")"
  case "$status" in
    healthy|running) echo "pass" ;;
    *) echo "fail" ;;
  esac
}

migrate_completion_status() {
  # migrate is restart:"no" — pass means its last run exited 0 (schema is up to date).
  local cid exit_code container_status
  cid="$(container_id migrate)"
  if [ -z "$cid" ]; then
    echo "fail"
    return
  fi
  container_status="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo "unknown")"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$cid" 2>/dev/null || echo "1")"
  if [ "$container_status" = "exited" ] && [ "$exit_code" = "0" ]; then
    echo "pass"
  else
    echo "fail"
  fi
}

ingress_read_api_check() {
  # $1=path (/healthz | /readyz) -> "pass" | "fail". Execs into the running ingress
  # container and fetches its OWN read-API listener on :3100 — the port is not published
  # to the host (see docker-compose.vps.yml). Mirrors scripts/smoke.sh's existing pattern.
  # The :3100 listener only binds when TRADING_LAB_READ_TOKEN is set (see
  # docker-compose.yml's ingress healthcheck comment) — a host provisioned without that
  # token correctly fails this check (fail-closed), it is not a false negative.
  local cid
  cid="$(container_id ingress)"
  [ -n "$cid" ] || { echo "fail"; return; }
  if docker exec "$cid" node -e "fetch('http://localhost:3100$1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "pass"
  else
    echo "fail"
  fi
}

image_ref() {
  # $1=service name -> the image reference the running container was started from (the
  # digest-pinned LAB_U6_IMAGE at deploy time).
  local cid
  cid="$(container_id "$1")"
  [ -n "$cid" ] || { echo ""; return; }
  docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || echo ""
}

INGRESS_HEALTHZ_CHECK="$(ingress_read_api_check /healthz)"
INGRESS_READYZ_CHECK="$(ingress_read_api_check /readyz)"
WORKER_CHECK="$(running_status worker)"
MIGRATE_CHECK="$(migrate_completion_status)"

DIGEST="$(image_ref ingress)"
if [ -z "$DIGEST" ]; then
  DIGEST="$(image_ref worker)"
fi
if [ -z "$DIGEST" ]; then
  DIGEST="$(image_ref migrate)"
fi

OK="true"
[ "$INGRESS_HEALTHZ_CHECK" = "pass" ] || OK="false"
[ "$INGRESS_READYZ_CHECK" = "pass" ] || OK="false"
[ "$WORKER_CHECK" = "pass" ] || OK="false"
[ "$MIGRATE_CHECK" = "pass" ] || OK="false"

DIGEST_ESC="$(json_escape "$DIGEST")"
printf '{"unit":"U6","digest":"%s","ok":%s,"checks":{"ingress_healthz":"%s","ingress_readyz":"%s","worker":"%s","migrate":"%s"}}\n' \
  "$DIGEST_ESC" "$OK" "$INGRESS_HEALTHZ_CHECK" "$INGRESS_READYZ_CHECK" "$WORKER_CHECK" "$MIGRATE_CHECK"

[ "$OK" = "true" ]
