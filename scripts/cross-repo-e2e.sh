#!/usr/bin/env bash
# Cross-repo E2E gate — lab → backtester → mock-platform (Feature 5/6).
# Requires demo stack: make demo (or detached equivalent).
# Usage: scripts/cross-repo-e2e.sh [demo|local]
set -euo pipefail

MODE="${1:-demo}"
ENV_FILE=".env.${MODE}"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.${MODE}.yml --env-file ${ENV_FILE}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing ${ENV_FILE} — run: cp .env.${MODE}.example ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ "$MODE" != "demo" ]; then
  echo "cross-repo-e2e supports MODE=demo only (mock-platform + backtester overlay)." >&2
  exit 1
fi

HOST_PORT="${BACKTESTER_HOST_PORT:-8081}"
API_URL="${BACKTESTER_API_URL:-http://127.0.0.1:${HOST_PORT}}"
API_TOKEN="${BACKTESTER_API_TOKEN:-${BACKTESTER_AUTH_TOKEN:-demo-backtester-token}}"

echo "[cross-repo-e2e:${MODE}] probing backtester at ${API_URL}…"
if ! curl -fsS --max-time 4 "${API_URL}/health" >/dev/null; then
  echo "Backtester not reachable. Start demo stack: make demo" >&2
  echo "Ensure docker-compose.${MODE}.yml publishes backtester on 127.0.0.1:${HOST_PORT}" >&2
  exit 1
fi

export RUN_CROSS_REPO_E2E=true
export BACKTESTER_API_URL="${API_URL}"
export BACKTESTER_API_TOKEN="${API_TOKEN}"

pnpm vitest run src/adapters/platform/cross-repo-e2e.integration.test.ts
echo "[cross-repo-e2e:${MODE}] PASS"
