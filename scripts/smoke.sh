#!/usr/bin/env bash
# Smoke-check the running stack for a mode. Usage: scripts/smoke.sh <demo|local|vps>
# Requires: docker compose (lab checks run inside the ingress container via node fetch) and
#           curl on the host (office host checks and the optional Ops Read probe use curl).
set -uo pipefail

MODE="${1:-demo}"
ENV_FILE=".env.${MODE}"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.${MODE}.yml --env-file ${ENV_FILE}"

# Load env (ports, tokens, optional platform URL) if the real env file exists.
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

WEB_PORT="${OFFICE_WEB_PORT:-8080}"
SRV_PORT="${OFFICE_SERVER_PORT:-8787}"
READ_TOKEN="${TRADING_LAB_READ_TOKEN:-demo-read-token}"
fail=0
pass(){ echo "  ✓ $1"; }
bad(){ echo "  ✗ $1"; fail=1; }

echo "[smoke:${MODE}] lab internal (via ingress container)…"
$COMPOSE exec -T ingress node -e "fetch('http://localhost:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && pass "lab health (/healthz)" || bad "lab health"
$COMPOSE exec -T ingress node -e "fetch('http://localhost:3100/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && pass "lab ready (/readyz)" || bad "lab ready"
$COMPOSE exec -T ingress node -e "fetch('http://localhost:3100/v1/agents',{headers:{authorization:'Bearer ${READ_TOKEN}'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && pass "lab read api (/v1/agents)" || bad "lab read api"
$COMPOSE exec -T ingress node -e "fetch('http://localhost:3100/v1/stream',{headers:{authorization:'Bearer ${READ_TOKEN}',accept:'text/event-stream'}}).then(r=>{const ok=r.ok&&(r.headers.get('content-type')||'').includes('text/event-stream');try{r.body&&r.body.cancel();}catch(e){};process.exit(ok?0:1)}).catch(()=>process.exit(1))" && pass "lab stream (/v1/stream)" || bad "lab stream"

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

if [ "$MODE" != "demo" ]; then
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
