# Docker VPS

Server deployment. Same stack, run detached with restart policies. Absolute paths, production-like env, secrets kept out of git.

## Prerequisites

- Docker + Compose v2 on the server.
- Checkouts at `/opt/trading-lab` and `/opt/trading-office` (adjust paths via env).

## Quickstart

```bash
cp .env.vps.example .env.vps
# edit .env.vps — fill every CHANGE_ME (including LAB_U6_IMAGE), set the real URLs
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps --profile office up -d
```

(Or `make vps`, which always includes `--profile office`.)

Note there is no `--build` above: since F5a, `migrate`/`ingress`/`worker` (U6) pull a digest-pinned,
prebuilt image (`LAB_U6_IMAGE`) rather than building on-host — see [U6 / immutable image](#u6--immutable-image-f5a)
below. `office-web`/`office-server` still build locally from `TRADING_OFFICE_PATH` (unchanged); `--build`
is harmless to keep if you want compose to (re)build those.

## Required edits in `.env.vps`

- `LAB_U6_IMAGE` — the digest-pinned lab image (`ghcr.io/trdlabs/lab@sha256:<64 hex>`) published by
  `.github/workflows/docker-publish.yml`. Required — compose refuses to render without it. Never a mutable
  tag (`latest`, `sha-<short>`); see [U6 / immutable image](#u6--immutable-image-f5a).
- `TRADING_OFFICE_PATH=/opt/trading-office` — only needed if you run office (see below).
- `OFFICE_CORS_ORIGIN` — the **web UI** public origin (the page origin), e.g. `https://office.example.com`.
- `VITE_OFFICE_GATEWAY_URL` — the **office-server (API)** public origin the browser calls, e.g.
  `https://office-api.example.com`. This is baked into the web build, so a wrong value here means the
  dashboard cannot reach its backend. It is **not** the web UI URL unless you use the same-origin variant.
- `TRADING_LAB_*_TOKEN` — set strong, distinct values (replace every `CHANGE_ME`).
- `OFFICE_PLATFORM_ENABLED` / `TRADING_PLATFORM_READ_URL` / `TRADING_PLATFORM_READ_TOKEN` — the read-only
  private source (URL only).
- `BIND_ADDR` — `0.0.0.0` to publish directly, or `127.0.0.1` when fronted by a host reverse proxy.

## U6 / immutable image (F5a)

`migrate`, `ingress`, and `worker` are unit U6 — a minimal, immutable artifact set that is provisioned and
health-checked independently of office. Two invariants:

- **Digest only.** `LAB_U6_IMAGE` must be `repo@sha256:<64 hex>` — enforced both by compose's required
  interpolation (`${LAB_U6_IMAGE:?...}`) and, more strictly, by `infra/scripts/unit-deploy.sh`'s own regex
  check. `docker-compose.vps.yml` resets the base file's `x-lab-image` build section
  (`build: !reset null`) for these three services, so compose can never silently fall back to building
  from source.
- **Office is excludable.** `office-web`/`office-server` sit behind the `office` Compose profile
  (`profiles: ["office"]` in `docker-compose.vps.yml`). Without `--profile office`, `docker compose config`
  and every U6 operation (`infra/scripts/unit-deploy.sh`, `infra/scripts/unit-health.sh`) succeed with no
  office checkout at all — U6 never touches office, redis, postgres, or phoenix. Operators who do run
  office pass `--profile office` explicitly; `make vps` does this by default so nothing changes for them.

U6 deploy/health primitives (used by a control-center orchestrator, or run by hand):

```bash
bash infra/scripts/unit-deploy.sh --env vps_staging --unit U6 --digest ghcr.io/trdlabs/lab@sha256:<64hex> --deploy-id <uuid>
bash infra/scripts/unit-health.sh --env vps_staging --unit U6 --deploy-id <uuid>
```

Each prints exactly one JSON object to stdout: `{"unit","digest","ok","checks",...}`. Diagnostics go to
stderr; secrets are never printed.

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
# Full stack (with office):
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps --profile office config >/dev/null && echo OK
# U6 only (office excluded — no TRADING_OFFICE_PATH checkout required):
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps config >/dev/null && echo OK
```

## Operate

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps --profile office ps
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps --profile office logs -f office-server
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps --profile office down
```

(Add `--profile office` to `ps`/`logs`/`down` whenever office is running — without it, compose only sees
U6 + infra. `infra/scripts/unit-deploy.sh`/`unit-health.sh` deliberately never pass `--profile office`:
U6 recreates only `migrate`/`ingress`/`worker` and never touches office.)
