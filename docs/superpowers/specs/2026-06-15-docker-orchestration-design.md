# Docker Orchestration — demo / local / vps

- **Date:** 2026-06-15
- **Status:** Approved design (pre-implementation)
- **Owner repo:** `trading-lab` (orchestration). Coordinated infra-only change in `trading-office`.
- **Out of scope:** `trading-platform` (private runtime) owns its own Dockerfile/runtime and is never built, mounted, cloned, or run by this feature.

## 1. Goal

Bring up the whole public environment with **one command per mode** so that, after start, a browser dashboard from `trading-office` is reachable and shows live data from `trading-lab`.

Three modes:

| Mode  | Command |
|-------|---------|
| demo  | `docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build` |
| local | `docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up --build` |
| vps   | `docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps up --build -d` |

## 2. Ownership boundaries

- **trading-lab** owns the `docker compose` orchestration (base + 3 overlays), the env examples, the smoke script, the Makefile, and the docs.
- **trading-office** owns its own build contract: `apps/server/Dockerfile`, `apps/web/Dockerfile`, `apps/web/nginx.conf`, `.dockerignore`. These are infra-only — **no app/business-logic changes**.
- **trading-platform** (private) is referenced only as an already-running read-only HTTP service (Ops Read API). Compose does not clone/mount/build/run it.

The compose references office through an env path:

```yaml
build:
  context: ${TRADING_OFFICE_PATH:-../trading-office}
  dockerfile: apps/server/Dockerfile   # (or apps/web/Dockerfile)
```

## 3. Architecture

### 3.1 Topology & data flow

One user-defined bridge network (`trading`). Internal service-to-service traffic uses Docker DNS service names. Only browser-facing ports are published.

```
Browser ── http://localhost:8080 ──▶ office-web  (nginx, static SPA)
Browser ── http://localhost:8787 ──▶ office-server (Hono; XHR /api/office/* + WS /api/office/events)
                                         │  OFFICE_CONNECTOR_MODE=trading-lab
                                         ├─▶ http://ingress:3100  (read-api: /healthz /readyz /v1/authz
                                         │                          /v1/stream /v1/agents /v1/agent-events ...)
                                         └─▶ http://ingress:3000  (/chat/messages)
ingress + worker ──▶ postgres:5432 , redis:6379          (internal only)
migrate (one-shot) ──▶ postgres:5432
[local/vps only] office-server ──▶ ${TRADING_PLATFORM_READ_URL}  (already-running Ops Read API :8839)
```

The browser **never** talks to trading-lab directly — office-server is the only caller (matches the lab's own ingress note and office's `secretExposure` boundary).

### 3.2 Port plan

| Service       | Container port(s) | Host-published?                | Notes |
|---------------|-------------------|--------------------------------|-------|
| office-web    | 80                | **only in overlays** → `${OFFICE_WEB_PORT:-8080}`   | browser entry (nginx static); base uses `expose` only |
| office-server | 8787              | **only in overlays** → `${OFFICE_SERVER_PORT:-8787}`| browser XHR + WS target; base uses `expose` only |
| ingress       | 3000 + 3100       | **no** (internal)              | read-api + chat/tasks |
| worker        | —                 | no                             | queue consumer |
| postgres      | 5432              | **no** (internal)              | avoids host conflict with platform pg |
| redis         | 6379              | **no** (internal)              | avoids host conflict with platform redis |

The **base defines no `ports:`** — only `expose:`. **All host publishing lives in the mode overlays** (demo/local bind `127.0.0.1`; vps binds `${BIND_ADDR:-0.0.0.0}`). Keeping `ports:` out of the base avoids Docker Compose port-list merge conflicts (overlay port lists append rather than replace) and prevents accidental broad binds. Because pg/redis/ingress are internal-only and the base publishes nothing, there is **no host-port conflict** with a running `trading-platform` (which uses 5432/6379/8839 on the host).

## 4. File deliverables

### 4.1 trading-lab (this repo)

| Path | Purpose |
|------|---------|
| `Dockerfile` | Single lab image (ingress / worker / migrate share it via command override). |
| `.dockerignore` | Exclude `node_modules`, `.git`, `.artifacts`, `.env*`, test output. |
| `docker-compose.yml` | **Expanded base** — full shared stack (was infra-only). |
| `docker-compose.demo.yml` | Demo deltas. |
| `docker-compose.local.yml` | Local deltas (URL-based optional private source). |
| `docker-compose.vps.yml` | VPS deltas (absolute paths, detached, restart policies). |
| `.env.demo.example` | Demo env template (dev tokens, no keys, no private source). |
| `.env.local.example` | Local env template (+ optional private Ops Read URL). |
| `.env.vps.example` | VPS env template (placeholders only, no real secrets). |
| `scripts/smoke.sh` | Smoke checklist runner: `scripts/smoke.sh <demo\|local\|vps>`. |
| `Makefile` | `make demo \| local \| vps \| down \| smoke` thin wrappers. |
| `docs/docker-demo.md` | Demo quickstart (neutral; no private platform). |
| `docs/docker-local.md` | Local quickstart (+ optional private source). |
| `docs/docker-vps.md` | VPS quickstart (secrets, reverse proxy, URL override). |
| `.gitignore` (edit) | Ignore real `.env.demo`, `.env.local`, `.env.vps`. |

The existing `.env.example` (host-dev defaults) is left untouched.

### 4.2 trading-office (sibling repo, infra-only)

| Path | Purpose |
|------|---------|
| `apps/server/Dockerfile` | `node:22-bookworm-slim`; `npm ci` at workspace root; `CMD ["npm","run","start","-w","@trading-office/server"]` (`tsx src/index.ts`). |
| `apps/web/Dockerfile` | Multi-stage: build stage runs `npm ci` + `npm run build -w @trading-office/web` (Vite → `apps/web/dist`); runtime stage = `nginx:alpine` serving the static build. `VITE_*` passed as build args. |
| `apps/web/nginx.conf` | SPA fallback (`try_files ... /index.html`). |
| `.dockerignore` | Exclude `node_modules`, `dist`, `.git`. |

Build context for both is the office repo **root** (workspaces + `tools/sync-floor-public.mjs` prebuild + `packages/*` assets are required by the web build).

## 5. Base compose (`docker-compose.yml`)

Repurposed from infra-only to the full shared stack. All connection values use service names; secrets/tokens come from the `--env-file` via `${VAR}` interpolation into each service's `environment:` block (with safe defaults). The base publishes **no** host ports — services that the browser reaches use `expose:` only, and every `ports:` mapping is defined in a mode overlay (§9). `ingress`, `migrate`, and `worker` share one build definition through a YAML anchor (`x-lab-image: { build.context: ., image: trading-lab:local }`), so `trading-lab:local` is built exactly once and no service relies on another to produce it.

### 5.1 Services

**postgres**
- image `pgvector/pgvector:pg16`; env `POSTGRES_USER=lab`, `POSTGRES_PASSWORD=lab`, `POSTGRES_DB=trading_lab`.
- named volume `lab_pg:/var/lib/postgresql/data`.
- healthcheck `pg_isready -U lab -d trading_lab`.
- no host port (internal).

**redis**
- image `redis:7-alpine`; healthcheck `redis-cli ping`.
- no host port (internal).

**migrate** (one-shot)
- build `.` (lab image); command `pnpm db:migrate`.
- env `DATABASE_URL=postgres://lab:lab@postgres:5432/trading_lab`.
- `depends_on: postgres (condition: service_healthy)`.
- `restart: "no"`.

**ingress**
- build `.` (lab image); command `pnpm ingress`.
- env: `DATABASE_URL`, `REDIS_URL=redis://redis:6379`, `INGRESS_PORT=3000`, `READ_API_PORT=3100`, and the four service tokens `TRADING_LAB_READ_TOKEN`, `TRADING_LAB_CHAT_TOKEN`, `TRADING_LAB_TASK_TOKEN`, `TRADING_LAB_CALLBACK_TOKEN` (from env file), plus adapter defaults (all `fake`, `TRADING_PLATFORM_INTEGRATION=mock`).
- `depends_on: postgres (healthy), redis (healthy), migrate (completed_successfully)`.
- healthcheck: `node -e "fetch('http://localhost:3100/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` (valid because `TRADING_LAB_READ_TOKEN` is set → read-api boots).
- no host port (internal).

**worker**
- build `.` (lab image); command `pnpm worker`.
- same DB/Redis/adapter env as ingress.
- `depends_on: postgres (healthy), redis (healthy), migrate (completed_successfully)`.

**office-server**
- build `context: ${TRADING_OFFICE_PATH:-../trading-office}`, `dockerfile: apps/server/Dockerfile`.
- env: `OFFICE_CONNECTOR_MODE=trading-lab`, `OFFICE_SERVER_PORT=8787`, `TRADING_LAB_READ_URL=http://ingress:3100`, `TRADING_LAB_READ_TOKEN`, `TRADING_LAB_CHAT_URL=http://ingress:3000`, `TRADING_LAB_CHAT_TOKEN`, `OFFICE_CORS_ORIGIN=${OFFICE_CORS_ORIGIN:-http://localhost:8080}`. Platform vars unset by default (demo).
- `depends_on: ingress (condition: service_healthy)`.
- `expose: ["8787"]` — **no host publishing in base** (overlays publish it).
- healthcheck: probe `http://localhost:8787/api/office/agents/statuses` (no dedicated `/health` route exists).

**office-web**
- build `context: ${TRADING_OFFICE_PATH:-../trading-office}`, `dockerfile: apps/web/Dockerfile`,
  `args: { VITE_OFFICE_MODE: connected, VITE_OFFICE_GATEWAY_URL: ${VITE_OFFICE_GATEWAY_URL:-http://localhost:8787} }`.
- `depends_on: office-server`.
- `expose: ["80"]` — **no host publishing in base** (overlays publish it).

### 5.2 Networks & volumes

- network `trading` (default bridge) on every service.
- volume `lab_pg` (postgres data).

## 6. The read-api token gotcha (load-bearing)

`src/ingress/server.ts` only starts the **read-api listener** (port 3100 — every endpoint the dashboard reads) **when `TRADING_LAB_READ_TOKEN` is set**. Therefore **all three** `.env.*.example` set `TRADING_LAB_READ_TOKEN` (and `TRADING_LAB_CHAT_TOKEN` so chat works). Without it the dashboard renders but stays empty.

These are service-to-service tokens; they never reach the browser (the web build bakes only `VITE_OFFICE_GATEWAY_URL`, a non-secret URL — enforced by office's existing `secretExposure.test.ts`).

## 7. office-web gateway URL (decision)

`HttpOfficeGateway` builds requests as `baseUrl + path` and derives the WS URL as `baseUrl.replace(/^http/, 'ws')` (so `http→ws`, `https→wss`), unless `VITE_OFFICE_GATEWAY_WS_URL` is set. A relative base would produce an invalid WS URL (`"/api/office/events"` with no `ws://` scheme) and would require an office **app-code** change — rejected (office stays infra-only).

**Decision:** build-arg per mode.
- `VITE_OFFICE_MODE=connected` (build arg, all modes).
- `VITE_OFFICE_GATEWAY_URL` (build arg from env) is the **public URL of office-server (the API) — not the web UI URL**. The browser uses it for `/api/office/*` XHR and the `/api/office/events` WebSocket. demo default `http://localhost:8787`. **vps must set the real public API origin**, which is typically a *different* origin from the web UI — e.g. API `https://office-api.example.com` vs UI `https://office.example.com`. WS auto-derives (`http→ws`/`https→wss`); set `VITE_OFFICE_GATEWAY_WS_URL` only for a split WS origin.
- Cross-origin is handled by `OFFICE_CORS_ORIGIN` = the **web UI (page) origin** that issues the requests (e.g. `https://office.example.com`).
- **Optional same-origin variant:** front the stack with a reverse proxy that serves the web UI and routes `/api/office/*` + the WS upgrade to office-server. Then a single public origin serves both, `VITE_OFFICE_GATEWAY_URL` = that origin, and CORS is moot. Valid **only** if the proxy actually forwards `/api/office/*` and the WS upgrade to office-server.

## 8. Private source integration (decision: URL-only)

**Mode semantics (decision):** **demo has no private source** (`OFFICE_PLATFORM_ENABLED=false`). **local and vps include the read-only Ops Read source by default** (`OFFICE_PLATFORM_ENABLED=true`), wired **by URL only**. (A local/vps operator can still opt out by setting `OFFICE_PLATFORM_ENABLED=false` in their env file — e.g. to run local fully offline.)

For local/vps, office-server needs exactly:

```
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=...
TRADING_PLATFORM_READ_TOKEN=...
```

Hard rules:
- `PRIVATE_RUNTIME_PATH` is **not required** and is **not** bind-mounted by default.
- Compose does **not** clone, mount, build, or run any private runtime code.
- office-server does **not** depend on any private-runtime check in the default local/vps command.
- office-server already fail-fasts at boot if `OFFICE_PLATFORM_ENABLED=true` (in trading-lab mode) without both URL and token — that is the honest failure for the URL contract.

**Optional** filesystem-path validation is available only behind an explicit profile and is **never** part of the default command:

```
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile private-path-check ... up
```

The `private-path-check` service (defined in the local/vps overlays, `profiles: ["private-path-check"]`) bind-mounts `${PRIVATE_RUNTIME_PATH}:ro` with `create_host_path: false` and asserts the directory is non-empty, exiting non-zero otherwise. It is a convenience guard, not a dependency.

### 8.1 Reaching a host-side Ops Read API

When trading-platform runs on the host (typical local), `localhost` inside a container is the container itself. local overlay therefore:
- sets `TRADING_PLATFORM_READ_URL=http://host.docker.internal:8839` (example), and
- adds `extra_hosts: ["host.docker.internal:host-gateway"]` to office-server (required on Linux/WSL2).

vps points `TRADING_PLATFORM_READ_URL` at the real internal/VPS host.

## 9. Mode overlays

### 9.1 `docker-compose.demo.yml`
- **Publishes ports (base has none):** `office-web` → `127.0.0.1:${OFFICE_WEB_PORT:-8080}:80`, `office-server` → `127.0.0.1:${OFFICE_SERVER_PORT:-8787}:8787`.
- `restart: "no"` on app services.
- Ensures demo-safe posture: `OFFICE_PLATFORM_ENABLED=false`, adapters `fake`, `TRADING_PLATFORM_INTEGRATION=mock` (these are also the base defaults).
- Fully self-contained: **no private source**, no exchange credentials, no live execution.

### 9.2 `docker-compose.local.yml`
- Extends the demo posture (but the command is `base + local.yml`, **not** `+ demo.yml`), so this overlay carries its own `ports:`.
- **Publishes ports:** `office-web` → `127.0.0.1:${OFFICE_WEB_PORT:-8080}:80`, `office-server` → `127.0.0.1:${OFFICE_SERVER_PORT:-8787}:8787`.
- Private read-only source **on by default**: `OFFICE_PLATFORM_ENABLED=${OFFICE_PLATFORM_ENABLED:-true}` (set `false` to run local without it), `TRADING_PLATFORM_READ_URL`, `TRADING_PLATFORM_READ_TOKEN`, `extra_hosts: ["host.docker.internal:host-gateway"]`.
- Optional `private-path-check` service (profile-gated, off by default).
- May publish lab read-api on a **shifted** host port for developer convenience (e.g. `127.0.0.1:3100:3100`) — optional, still internal-first.

### 9.3 `docker-compose.vps.yml`
- Extends the same base; carries its own `ports:`.
- **Publishes ports:** `office-web` → `${BIND_ADDR:-0.0.0.0}:${OFFICE_WEB_PORT:-8080}:80`, `office-server` → `${BIND_ADDR:-0.0.0.0}:${OFFICE_SERVER_PORT:-8787}:8787`. Set `BIND_ADDR=127.0.0.1` when fronted by a host reverse proxy.
- Private read-only source **on by default** (same vars as local), pointed at the real internal/VPS host.
- Absolute build/path env: `TRADING_OFFICE_PATH=/opt/trading-office`, `PRIVATE_RUNTIME_PATH=/opt/trading-platform` (the latter only used if the optional `private-path-check` profile is invoked).
- `restart: unless-stopped` on long-lived services; intended for `up -d`.
- No infra (pg/redis/ingress) host ports.
- Prod env via gitignored `.env.vps`.
- Live execution never auto-starts: lab stays `mock`; enabling any real runtime/exchange path requires explicit env, never a default.

## 10. Env example files (committed templates)

All three are `.example` files; the real `.env.<mode>` are gitignored.

**`.env.demo.example`** (no secrets, no keys, no private source):
```
COMPOSE_PROJECT_NAME=trading-demo
TRADING_OFFICE_PATH=../trading-office
OFFICE_WEB_PORT=8080
OFFICE_SERVER_PORT=8787
OFFICE_CORS_ORIGIN=http://localhost:8080
VITE_OFFICE_GATEWAY_URL=http://localhost:8787
# trading-lab service-to-service tokens (dev values; required so read-api + chat boot)
TRADING_LAB_READ_TOKEN=demo-read-token
TRADING_LAB_CHAT_TOKEN=demo-chat-token
TRADING_LAB_TASK_TOKEN=demo-task-token
TRADING_LAB_CALLBACK_TOKEN=demo-callback-token
# adapters: all fake, platform mock (defaults — listed for clarity)
# STRATEGY_ANALYST_ADAPTER=fake ... TRADING_PLATFORM_INTEGRATION=mock
```

**`.env.local.example`** (demo + optional private Ops Read URL):
```
# ...all demo vars...
COMPOSE_PROJECT_NAME=trading-local
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=http://host.docker.internal:8839
TRADING_PLATFORM_READ_TOKEN=replace-with-ops-read-token
# Optional, only for `--profile private-path-check`:
PRIVATE_RUNTIME_PATH=../trading-platform
# Optional real LLM (commented): MODEL_PROVIDER=..., *_ADAPTER=mastra, *_API_KEY=...
```

**`.env.vps.example`** (placeholders only — never real tokens):
```
COMPOSE_PROJECT_NAME=trading-vps
TRADING_OFFICE_PATH=/opt/trading-office
BIND_ADDR=0.0.0.0
OFFICE_WEB_PORT=8080
OFFICE_SERVER_PORT=8787
OFFICE_CORS_ORIGIN=https://office.example.com           # web UI (page) origin
VITE_OFFICE_GATEWAY_URL=https://office-api.example.com  # office-server (API) public origin — baked into web build
# Same-origin variant (reverse proxy routes /api/office/* + WS upgrade to office-server):
#   set OFFICE_CORS_ORIGIN and VITE_OFFICE_GATEWAY_URL both to https://office.example.com
TRADING_LAB_READ_TOKEN=CHANGE_ME
TRADING_LAB_CHAT_TOKEN=CHANGE_ME
TRADING_LAB_TASK_TOKEN=CHANGE_ME
TRADING_LAB_CALLBACK_TOKEN=CHANGE_ME
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=http://internal-platform-host:8839
TRADING_PLATFORM_READ_TOKEN=CHANGE_ME
PRIVATE_RUNTIME_PATH=/opt/trading-platform   # only used by --profile private-path-check
```

## 11. Secrets posture

- Only `*.example` files are committed; real `.env.demo/.local/.vps` are gitignored.
- Demo example uses obviously-dev tokens (`demo-*`), never real credentials.
- vps example uses `CHANGE_ME` placeholders only.
- Web build bakes only `VITE_OFFICE_GATEWAY_URL` (a URL). No tokens enter the web image.

## 12. Smoke check (`scripts/smoke.sh <mode>`)

Requires `docker compose` and `curl`. Lab checks run inside the ingress container via `docker compose exec -T ingress node -e "fetch(...)"` (Node 22 has global fetch); office host checks and the optional Ops Read probe use `curl` against the published ports / URL.

| Check | How |
|-------|-----|
| lab health | `exec ingress` → `GET http://localhost:3100/healthz` 200 |
| lab ready | `exec ingress` → `GET http://localhost:3100/readyz` 200 |
| lab read api | `exec ingress` → `GET http://localhost:3100/v1/agents` (Bearer read token) 200 |
| lab stream | `exec ingress` → `GET http://localhost:3100/v1/stream` first chunk received |
| office server | host `GET http://localhost:${OFFICE_SERVER_PORT}/api/office/agents/statuses` 200 |
| office web | host `GET http://localhost:${OFFICE_WEB_PORT}/` 200 + HTML |
| private Ops Read (local/vps only) | if `TRADING_PLATFORM_READ_URL` **and** `TRADING_PLATFORM_READ_TOKEN` are set → `curl -H "Authorization: Bearer …" …/ops/discover`; skipped if either is empty or in demo; never starts the private runtime |

## 13. Host-dev infra-only (back-compat)

Repurposing `docker-compose.yml` to the full stack changes the old habit where a bare `docker compose up` started only pg+redis. Documented replacement:

```
docker compose up postgres redis     # infra only, for host-side `pnpm ingress` / `pnpm worker`
```

## 14. Verification plan

1. `docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo config` — valid.
2. `... -f docker-compose.local.yml --env-file .env.local config` — valid.
3. `... -f docker-compose.vps.yml --env-file .env.vps config` — valid.
4. **demo only:** `up --build`, then `scripts/smoke.sh demo` green; open `http://localhost:8080` and confirm the dashboard shows lab data.
5. local/vps: `config` only. Optionally probe `TRADING_PLATFORM_READ_URL` if provided & reachable. **Do not** start the private runtime or any live-execution service.

## 15. Definition of Done → coverage

| DoD | Covered by |
|-----|-----------|
| 1. `config` passes for demo/local/vps | §14.1–3 |
| 2. demo one-command up | §1, §5, §9.1 |
| 3. dashboard opens after demo | office-web published (§3.2) |
| 4. dashboard data via office-server/read-api/SSE | §3.1, §6 |
| 5. lab health/authz/agents/events reachable in-stack | §12 |
| 6. private source only with provided URL (local/vps) | §8 |
| 7. compose never clones private repos | §2, §8 |
| 8. no committed secrets | §11 |
| 9. quickstart docs for all modes | §4.1 docs |
| 10. smoke script/checklist | §12 |

## 16. Trade-offs & risks

- **Base repurposing** (infra-only → full stack) changes host-dev habit — mitigated/documented (§13).
- **Cross-repo office Dockerfiles** — a second small infra-only change in trading-office.
- **Separate office-web + office-server** (nginx + node) instead of single-origin — costs one CORS setting + one extra published port; avoids touching office app code.
- **`host.docker.internal` on Linux/WSL2** needs `extra_hosts: host-gateway` (handled in local overlay).
- **`build.dockerfile_inline` not used** (rejected) — office build contract lives in office repo per ownership boundary.
