# Docker VPS

Server deployment. Same stack, run detached with restart policies. Absolute paths, production-like env, secrets kept out of git.

## Prerequisites

- Docker + Compose v2 on the server.
- Checkouts at `/opt/trading-lab` and `/opt/trading-office` (adjust paths via env).

## Quickstart

```bash
cp .env.vps.example .env.vps
# edit .env.vps — fill every CHANGE_ME, set the real URLs
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps up --build -d
```

(Or `make vps`.)

## Required edits in `.env.vps`

- `TRADING_OFFICE_PATH=/opt/trading-office`
- `OFFICE_CORS_ORIGIN` — the **web UI** public origin (the page origin), e.g. `https://office.example.com`.
- `VITE_OFFICE_GATEWAY_URL` — the **office-server (API)** public origin the browser calls, e.g.
  `https://office-api.example.com`. This is baked into the web build, so a wrong value here means the
  dashboard cannot reach its backend. It is **not** the web UI URL unless you use the same-origin variant.
- `TRADING_LAB_*_TOKEN` — set strong, distinct values (replace every `CHANGE_ME`).
- `OFFICE_PLATFORM_ENABLED` / `TRADING_PLATFORM_READ_URL` / `TRADING_PLATFORM_READ_TOKEN` — the read-only
  private source (URL only).
- `BIND_ADDR` — `0.0.0.0` to publish directly, or `127.0.0.1` when fronted by a host reverse proxy.

### Same-origin variant (optional)

Put a reverse proxy in front that serves the web UI and routes `/api/office/*` + the WebSocket upgrade
to office-server. Then set both `OFFICE_CORS_ORIGIN` and `VITE_OFFICE_GATEWAY_URL` to the single public
origin (e.g. `https://office.example.com`) and CORS is moot.

## Secrets

- Only `*.example` files are committed. `.env.vps` is gitignored — keep real tokens out of git.
- The web build bakes only `VITE_OFFICE_GATEWAY_URL` (a URL). No tokens reach the browser bundle.

## Live execution

Live execution never auto-starts: the lab runs in `mock`. Enabling any real runtime/exchange path
requires deliberate env changes — it is never a default.

## Validate without starting

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps config >/dev/null && echo OK
```

## Operate

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps ps
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps logs -f office-server
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps down
```
