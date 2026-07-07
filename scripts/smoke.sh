#!/usr/bin/env bash
# Smoke-check the running stack for a mode. Usage: scripts/smoke.sh <demo|dev|local|vps>
# Requires: docker compose (demo/local/vps) or host processes (dev) + curl.
set -uo pipefail

MODE="${1:-demo}"
ENV_FILE=".env.${MODE}"
if [ "$MODE" = "dev" ]; then
  COMPOSE="docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file ${ENV_FILE}"
else
  COMPOSE="docker compose -f docker-compose.yml -f docker-compose.${MODE}.yml --env-file ${ENV_FILE}"
fi

# Load env (ports, tokens, optional platform URL) if the real env file exists.
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

if [ "$MODE" = "dev" ]; then
  WEB_PORT="${OFFICE_WEB_PORT:-5174}"
else
  WEB_PORT="${OFFICE_WEB_PORT:-8080}"
fi
SRV_PORT="${OFFICE_SERVER_PORT:-8787}"
READ_PORT="${READ_API_PORT:-3100}"
READ_TOKEN="${TRADING_LAB_READ_TOKEN:-demo-read-token}"
fail=0
pass(){ echo "  ✓ $1"; }
bad(){ echo "  ✗ $1"; fail=1; }

node_fetch() {
  local url="$1"
  node -e "fetch('${url}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

node_fetch_auth() {
  local url="$1" token="$2"
  node -e "fetch('${url}',{headers:{authorization:'Bearer ${token}'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

node_fetch_stream() {
  local url="$1" token="$2"
  node -e "fetch('${url}',{headers:{authorization:'Bearer ${token}',accept:'text/event-stream'}}).then(r=>{const ok=r.ok&&(r.headers.get('content-type')||'').includes('text/event-stream');try{r.body&&r.body.cancel();}catch(e){};process.exit(ok?0:1)}).catch(()=>process.exit(1))"
}

if [ "$MODE" = "dev" ]; then
  echo "[smoke:dev] lab (host read-api :${READ_PORT})…"
  node_fetch "http://localhost:${READ_PORT}/healthz" && pass "lab health (/healthz)" || bad "lab health"
  node_fetch "http://localhost:${READ_PORT}/readyz" && pass "lab ready (/readyz)" || bad "lab ready"
  node_fetch_auth "http://localhost:${READ_PORT}/v1/agents" "$READ_TOKEN" && pass "lab read api (/v1/agents)" || bad "lab read api"
  node_fetch_stream "http://localhost:${READ_PORT}/v1/stream" "$READ_TOKEN" && pass "lab stream (/v1/stream)" || bad "lab stream"
else
  echo "[smoke:${MODE}] lab internal (via ingress container)…"
  $COMPOSE exec -T ingress node -e "fetch('http://localhost:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && pass "lab health (/healthz)" || bad "lab health"
  $COMPOSE exec -T ingress node -e "fetch('http://localhost:3100/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && pass "lab ready (/readyz)" || bad "lab ready"
  $COMPOSE exec -T ingress node -e "fetch('http://localhost:3100/v1/agents',{headers:{authorization:'Bearer ${READ_TOKEN}'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && pass "lab read api (/v1/agents)" || bad "lab read api"
  $COMPOSE exec -T ingress node -e "fetch('http://localhost:3100/v1/stream',{headers:{authorization:'Bearer ${READ_TOKEN}',accept:'text/event-stream'}}).then(r=>{const ok=r.ok&&(r.headers.get('content-type')||'').includes('text/event-stream');try{r.body&&r.body.cancel();}catch(e){};process.exit(ok?0:1)}).catch(()=>process.exit(1))" && pass "lab stream (/v1/stream)" || bad "lab stream"
fi

echo "[smoke:${MODE}] office (host ports)…"
curl -fsS "http://localhost:${SRV_PORT}/api/office/agents/statuses" >/dev/null && pass "office server (/api/office/agents/statuses)" || bad "office server"
curl -fsS "http://localhost:${WEB_PORT}/" | grep -qi "<!doctype html" && pass "office web (/)" || bad "office web"

if [ "$MODE" = "demo" ]; then
  echo "[smoke:${MODE}] mock-platform (via ingress container)…"
  MOCK_TOKEN="${MOCK_OPS_TOKEN:-}"
  $COMPOSE exec -T ingress node -e "fetch('http://mock-platform:8839/ops/discover',{headers:{Authorization:'Bearer ${MOCK_TOKEN}'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    && pass "mock-platform /ops/discover" || bad "mock-platform /ops/discover"

  echo "[smoke:${MODE}] backtester (via ingress container)…"
  $COMPOSE exec -T ingress node -e "fetch('http://backtester:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    && pass "backtester /health" || bad "backtester /health"
fi

if [ "$MODE" = "dev" ]; then
  echo "[smoke:dev] mock-platform (host :8839)…"
  MOCK_TOKEN="${MOCK_OPS_TOKEN:-}"
  node -e "fetch('http://localhost:8839/ops/discover',{headers:{Authorization:'Bearer ${MOCK_TOKEN}'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    && pass "mock-platform /ops/discover" || bad "mock-platform /ops/discover"

  echo "[smoke:dev] backtester (host :${BACKTESTER_PORT:-8080})…"
  node -e "fetch('http://localhost:${BACKTESTER_PORT:-8080}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    && pass "backtester /health" || bad "backtester /health"
fi

if [ "$MODE" != "demo" ] && [ "$MODE" != "dev" ]; then
  echo "[smoke:${MODE}] optional private Ops Read…"
  if [ -n "${TRADING_PLATFORM_READ_URL:-}" ] && [ -n "${TRADING_PLATFORM_READ_TOKEN:-}" ]; then
    if curl -fsS --max-time 4 -H "Authorization: Bearer ${TRADING_PLATFORM_READ_TOKEN}" "${TRADING_PLATFORM_READ_URL%/}/ops/discover" >/dev/null 2>&1; then
      pass "private Ops Read reachable (${TRADING_PLATFORM_READ_URL})"
    else
      echo "  • private Ops Read not reachable — skipped (optional; not started by compose)"
    fi
  else
    echo "  • TRADING_PLATFORM_READ_URL/TOKEN not both set — private source check skipped"
  fi
fi

if [ "$fail" -eq 0 ]; then echo "[smoke:${MODE}] PASS"; else echo "[smoke:${MODE}] FAIL"; exit 1; fi
