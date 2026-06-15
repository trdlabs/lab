# Docker Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring up the full public stack (trading-lab + trading-office dashboard) with one `docker compose` command per mode (demo / local / vps), with demo fully self-contained (fake agents, no keys, no private runtime).

**Architecture:** A single base `docker-compose.yml` defines every shared service (postgres, redis, migrate, ingress, worker, office-server, office-web) using internal Docker-DNS wiring and `expose` only. Three thin overlays add host-port publishing and mode deltas. trading-lab gets one Dockerfile (ingress/worker/migrate share it); trading-office gets its own Dockerfiles (server + nginx-served web) in its own repo. The optional private operational source is wired URL-only.

**Tech Stack:** Docker Compose v2 (≥2.17), Node 22, pnpm (lab) / npm workspaces (office), Hono, Vite, nginx, Postgres (pgvector), Redis (BullMQ), drizzle-kit.

**Reference spec:** `docs/superpowers/specs/2026-06-15-docker-orchestration-design.md`

**Conventions for every task below:**
- This is infra. The "tests" are `docker compose config`, image builds, container healthchecks, and the smoke script — those are the gates that must pass.
- Run all `docker compose` / `make` commands from the trading-lab repo root unless stated otherwise.
- Commit after each task. Lab commits go on branch `docker-orchestration`. Office commits go on the office branch created in Task 1.

---

## File structure

**trading-lab** (branch `docker-orchestration`):
- `Dockerfile` — single lab image; command overridden per service.
- `.dockerignore`
- `docker-compose.yml` — base (rewrite of the current infra-only file).
- `docker-compose.demo.yml`, `docker-compose.local.yml`, `docker-compose.vps.yml`
- `.env.demo.example`, `.env.local.example`, `.env.vps.example`
- `scripts/smoke.sh`
- `Makefile`
- `docs/docker-demo.md`, `docs/docker-local.md`, `docs/docker-vps.md`
- `.gitignore` (append real env files)

**trading-office** (new branch `docker-build-contract`, infra-only):
- `apps/server/Dockerfile`
- `apps/web/Dockerfile`
- `apps/web/nginx.conf`
- `.dockerignore`

---

## Task 1: Branch trading-office for the build contract

**Files:** none yet (branch only).

- [ ] **Step 1: Create the office branch**

```bash
git -C ../trading-office checkout -b docker-build-contract
git -C ../trading-office status -sb
```
Expected: `On branch docker-build-contract`, clean tree.

- [ ] **Step 2: Confirm the lab branch is current**

```bash
git branch --show-current
```
Expected: `docker-orchestration`. If not: `git checkout docker-orchestration`.

(No commit — branch bookkeeping only.)

---

## Task 2: trading-lab Dockerfile + .dockerignore

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
.git
.artifacts
.artifacts-test
dist
assets
.env
.env.*
docs
*.md
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
# Single image for the trading-lab runtime. No build step — the app runs via
# `node --experimental-strip-types`. The `migrate`, `ingress`, and `worker`
# compose services all run this image with a different command.
FROM node:22-bookworm-slim

# pnpm via corepack (version pinned by package.json "packageManager")
RUN corepack enable
WORKDIR /app

# Install deps first for layer caching. The vendored SDK tarball referenced by
# package.json (file:./vendor/...) must be present before install.
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile

# App source (src, migrations, drizzle.config.js, scripts, tsconfig.json, ...)
COPY . .

# Default command; overridden by each compose service.
CMD ["pnpm", "ingress"]
```

- [ ] **Step 3: Build the image (this is the gate)**

Run:
```bash
docker build -t trading-lab:local .
```
Expected: build succeeds, ends with `naming to docker.io/library/trading-lab:local`.

> If `pnpm install` fails because a dependency needs native build tooling, change the first line to `FROM node:22-bookworm` (full image, includes python3/make/g++) and rebuild.

- [ ] **Step 4: Smoke the image can resolve the entrypoints**

Run:
```bash
docker run --rm trading-lab:local node -e "console.log('node', process.version)"
```
Expected: prints `node v22.x.x`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(docker): trading-lab runtime image (ingress/worker/migrate share it)"
```

---

## Task 3: trading-office build contract (Dockerfiles + nginx)

**Files (in `../trading-office`):**
- Create: `../trading-office/apps/server/Dockerfile`
- Create: `../trading-office/apps/web/Dockerfile`
- Create: `../trading-office/apps/web/nginx.conf`
- Create: `../trading-office/.dockerignore`

- [ ] **Step 1: Create `../trading-office/.dockerignore`**

```
node_modules
**/node_modules
.git
dist
**/dist
*.tsbuildinfo
.env
.env.local
```

- [ ] **Step 2: Create `../trading-office/apps/server/Dockerfile`**

```dockerfile
# Office gateway/server (Hono, stateless). Runs via tsx. Build context = office repo root.
FROM node:22-bookworm-slim
WORKDIR /app
# npm workspaces: the whole repo is needed to resolve workspace deps.
COPY . .
RUN npm ci
EXPOSE 8787
CMD ["npm", "run", "start", "-w", "@trading-office/server"]
```

- [ ] **Step 3: Create `../trading-office/apps/web/nginx.conf`**

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback — every unknown path serves index.html.
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

- [ ] **Step 4: Create `../trading-office/apps/web/Dockerfile`**

```dockerfile
# Office web (Vite/React) → static build served by nginx. Build context = office repo root.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci

# The browser uses these at runtime; Vite bakes them into the static build.
# VITE_OFFICE_GATEWAY_URL is the PUBLIC office-server (API) origin — not a secret.
ARG VITE_OFFICE_MODE=connected
ARG VITE_OFFICE_GATEWAY_URL=http://localhost:8787
ENV VITE_OFFICE_MODE=$VITE_OFFICE_MODE
ENV VITE_OFFICE_GATEWAY_URL=$VITE_OFFICE_GATEWAY_URL

# Default Vite mode + our env vars (Vite includes VITE_-prefixed process.env vars).
RUN npm run build -w @trading-office/web

FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 5: Build both office images (the gate)**

Run:
```bash
docker build -t trading-office-server:local -f ../trading-office/apps/server/Dockerfile ../trading-office
docker build -t trading-office-web:local \
  --build-arg VITE_OFFICE_MODE=connected \
  --build-arg VITE_OFFICE_GATEWAY_URL=http://localhost:8787 \
  -f ../trading-office/apps/web/Dockerfile ../trading-office
```
Expected: both builds succeed. The web build runs `tsc --noEmit && vite build` and emits `apps/web/dist`.

> If `npm ci` needs native tooling, switch the relevant `FROM node:22-bookworm-slim` to `FROM node:22-bookworm`.

- [ ] **Step 6: Verify the web image serves HTML and has no baked tokens**

Run:
```bash
docker run --rm -d --name office-web-test -p 18080:80 trading-office-web:local
sleep 1
curl -fsS http://localhost:18080/ | grep -qi "<!doctype html" && echo "WEB OK"
docker run --rm trading-office-web:local sh -c "grep -ric 'demo-read-token\|TRADING_LAB_READ_TOKEN\|TRADING_PLATFORM_READ_TOKEN' /usr/share/nginx/html || true"
docker rm -f office-web-test
```
Expected: `WEB OK`; the grep prints `0` (no token strings in the static bundle).

- [ ] **Step 7: Commit (in the office repo)**

```bash
git -C ../trading-office add apps/server/Dockerfile apps/web/Dockerfile apps/web/nginx.conf .dockerignore
git -C ../trading-office commit -m "feat(docker): infra-only build contract (server + nginx web Dockerfiles)"
```

---

## Task 4: Base `docker-compose.yml` (full stack)

**Files:**
- Modify (full rewrite): `docker-compose.yml`

- [ ] **Step 1: Rewrite `docker-compose.yml`**

```yaml
# Base stack — every shared service. Host publishing lives in the mode overlays
# (docker-compose.{demo,local,vps}.yml); this base uses `expose` only.
#
# Run with an overlay, e.g.:
#   docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build
#
# Infra-only for host development (run `pnpm ingress` / `pnpm worker` on the host):
#   docker compose up postgres redis

# Shared build for the lab image — declared once, reused by ingress/migrate/worker via the
# YAML anchor below. Docker builds trading-lab:local a single time (keyed by the image tag),
# so no service depends on another to produce the image.
x-lab-image: &lab-image
  build:
    context: .
  image: trading-lab:local

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: lab
      POSTGRES_PASSWORD: lab
      POSTGRES_DB: trading_lab
    volumes:
      - lab_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lab -d trading_lab"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [trading]

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [trading]

  ingress:
    <<: *lab-image
    command: ["pnpm", "ingress"]
    environment:
      DATABASE_URL: postgres://lab:lab@postgres:5432/trading_lab
      REDIS_URL: redis://redis:6379
      INGRESS_PORT: "3000"
      READ_API_PORT: "3100"
      TRADING_LAB_READ_TOKEN: ${TRADING_LAB_READ_TOKEN:-}
      TRADING_LAB_CHAT_TOKEN: ${TRADING_LAB_CHAT_TOKEN:-}
      TRADING_LAB_TASK_TOKEN: ${TRADING_LAB_TASK_TOKEN:-}
      TRADING_LAB_CALLBACK_TOKEN: ${TRADING_LAB_CALLBACK_TOKEN:-}
      TRADING_PLATFORM_INTEGRATION: ${TRADING_PLATFORM_INTEGRATION:-mock}
      MODEL_PROVIDER: ${MODEL_PROVIDER:-anthropic}
      STRATEGY_ANALYST_ADAPTER: ${STRATEGY_ANALYST_ADAPTER:-fake}
      RESEARCHER_ADAPTER: ${RESEARCHER_ADAPTER:-fake}
      CRITIC_ADAPTER: ${CRITIC_ADAPTER:-fake}
      BUILDER_ADAPTER: ${BUILDER_ADAPTER:-fake}
      INTENT_CLASSIFIER_ADAPTER: ${INTENT_CLASSIFIER_ADAPTER:-fake}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    expose:
      - "3000"
      - "3100"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3100/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    networks: [trading]

  migrate:
    <<: *lab-image
    command: ["pnpm", "db:migrate"]
    environment:
      DATABASE_URL: postgres://lab:lab@postgres:5432/trading_lab
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"
    networks: [trading]

  worker:
    <<: *lab-image
    command: ["pnpm", "worker"]
    environment:
      DATABASE_URL: postgres://lab:lab@postgres:5432/trading_lab
      REDIS_URL: redis://redis:6379
      TRADING_PLATFORM_INTEGRATION: ${TRADING_PLATFORM_INTEGRATION:-mock}
      MODEL_PROVIDER: ${MODEL_PROVIDER:-anthropic}
      STRATEGY_ANALYST_ADAPTER: ${STRATEGY_ANALYST_ADAPTER:-fake}
      RESEARCHER_ADAPTER: ${RESEARCHER_ADAPTER:-fake}
      CRITIC_ADAPTER: ${CRITIC_ADAPTER:-fake}
      BUILDER_ADAPTER: ${BUILDER_ADAPTER:-fake}
      INTENT_CLASSIFIER_ADAPTER: ${INTENT_CLASSIFIER_ADAPTER:-fake}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    networks: [trading]

  office-server:
    build:
      context: ${TRADING_OFFICE_PATH:-../trading-office}
      dockerfile: apps/server/Dockerfile
    environment:
      OFFICE_CONNECTOR_MODE: trading-lab
      OFFICE_SERVER_PORT: "8787"
      OFFICE_CORS_ORIGIN: ${OFFICE_CORS_ORIGIN:-http://localhost:8080}
      TRADING_LAB_READ_URL: http://ingress:3100
      TRADING_LAB_READ_TOKEN: ${TRADING_LAB_READ_TOKEN:-}
      TRADING_LAB_CHAT_URL: http://ingress:3000
      TRADING_LAB_CHAT_TOKEN: ${TRADING_LAB_CHAT_TOKEN:-}
      OFFICE_PLATFORM_ENABLED: ${OFFICE_PLATFORM_ENABLED:-false}
      TRADING_PLATFORM_READ_URL: ${TRADING_PLATFORM_READ_URL:-}
      TRADING_PLATFORM_READ_TOKEN: ${TRADING_PLATFORM_READ_TOKEN:-}
    depends_on:
      ingress:
        condition: service_healthy
    expose:
      - "8787"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8787/api/office/agents/statuses').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s
    networks: [trading]

  office-web:
    build:
      context: ${TRADING_OFFICE_PATH:-../trading-office}
      dockerfile: apps/web/Dockerfile
      args:
        VITE_OFFICE_MODE: connected
        VITE_OFFICE_GATEWAY_URL: ${VITE_OFFICE_GATEWAY_URL:-http://localhost:8787}
    depends_on:
      office-server:
        condition: service_started
    expose:
      - "80"
    networks: [trading]

volumes:
  lab_pg:

networks:
  trading:
    driver: bridge
```

- [ ] **Step 2: Validate the base parses**

Run:
```bash
docker compose -f docker-compose.yml config >/dev/null && echo "BASE OK"
```
Expected: `BASE OK` (unset-variable warnings are fine).

- [ ] **Step 3: Verify infra-only back-compat still works**

Run:
```bash
docker compose up -d postgres redis
docker compose ps
docker compose down
```
Expected: postgres + redis start (healthy) and stop cleanly; no app services started.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(docker): expand base compose into full shared stack (expose-only, no host ports)"
```

---

## Task 5: Demo overlay + env example + gitignore

**Files:**
- Create: `.env.demo.example`
- Create: `docker-compose.demo.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Create `.env.demo.example`**

```
# Demo — public, self-contained, key-free. Copy to .env.demo, then:
#   docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build
# Open http://localhost:8080

COMPOSE_PROJECT_NAME=trading-demo

# Build context for the trading-office images (sibling checkout).
TRADING_OFFICE_PATH=../trading-office

# Browser-facing host ports.
OFFICE_WEB_PORT=8080
OFFICE_SERVER_PORT=8787

# Web UI (page) origin — used for office-server CORS.
OFFICE_CORS_ORIGIN=http://localhost:8080
# Public office-server (API) origin baked into the web build (browser -> office-server).
VITE_OFFICE_GATEWAY_URL=http://localhost:8787

# trading-lab service-to-service tokens. Dev values (safe to commit as an example).
# REQUIRED so the read API (dashboard data) and chat boot.
TRADING_LAB_READ_TOKEN=demo-read-token
TRADING_LAB_CHAT_TOKEN=demo-chat-token
TRADING_LAB_TASK_TOKEN=demo-task-token
TRADING_LAB_CALLBACK_TOKEN=demo-callback-token

# Agents + platform: fake/mock defaults (no API key, no private runtime).
TRADING_PLATFORM_INTEGRATION=mock
```

- [ ] **Step 2: Create `docker-compose.demo.yml`**

```yaml
# Demo overlay — self-contained, key-free, no private source. Binds to 127.0.0.1.
services:
  office-web:
    ports:
      - "127.0.0.1:${OFFICE_WEB_PORT:-8080}:80"
    restart: "no"
  office-server:
    ports:
      - "127.0.0.1:${OFFICE_SERVER_PORT:-8787}:8787"
    restart: "no"
    environment:
      OFFICE_PLATFORM_ENABLED: "false"
  ingress:
    restart: "no"
  worker:
    restart: "no"
```

- [ ] **Step 3: Append real env files to `.gitignore`**

Add these lines to the end of `.gitignore`:
```
# Docker orchestration — real env files (only *.example are committed)
.env.demo
.env.local
.env.vps
```

- [ ] **Step 4: Validate the demo config merge (the gate)**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo.example config >/dev/null && echo "DEMO OK"
```
Expected: `DEMO OK`.

- [ ] **Step 5: Verify the demo published ports are 127.0.0.1-bound**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo.example config | grep -A3 'published'
```
Expected: published ports show `host_ip: 127.0.0.1` for 8080 and 8787.

- [ ] **Step 6: Commit**

```bash
git add .env.demo.example docker-compose.demo.yml .gitignore
git commit -m "feat(docker): demo overlay + env example (self-contained, 127.0.0.1)"
```

---

## Task 6: Local overlay + env example

**Files:**
- Create: `.env.local.example`
- Create: `docker-compose.local.yml`

- [ ] **Step 1: Create `.env.local.example`**

```
# Local — developer machine. Demo posture + optional read-only private Ops Read source (URL only).
# Copy to .env.local, then:
#   docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up --build

COMPOSE_PROJECT_NAME=trading-local

TRADING_OFFICE_PATH=../trading-office

OFFICE_WEB_PORT=8080
OFFICE_SERVER_PORT=8787
OFFICE_CORS_ORIGIN=http://localhost:8080
VITE_OFFICE_GATEWAY_URL=http://localhost:8787

TRADING_LAB_READ_TOKEN=demo-read-token
TRADING_LAB_CHAT_TOKEN=demo-chat-token
TRADING_LAB_TASK_TOKEN=demo-task-token
TRADING_LAB_CALLBACK_TOKEN=demo-callback-token

TRADING_PLATFORM_INTEGRATION=mock

# --- Optional read-only private operational source (ON by default in local) ---
# Point at an ALREADY-RUNNING trading-platform Ops Read API. Set ENABLED=false to run offline.
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=http://host.docker.internal:8839
TRADING_PLATFORM_READ_TOKEN=replace-with-ops-read-token

# Only used by the optional `--profile private-path-check` guard:
PRIVATE_RUNTIME_PATH=../trading-platform

# --- Optional: real LLM instead of fake agents ---
# MODEL_PROVIDER=openai
# OPENAI_API_KEY=sk-...
# RESEARCHER_ADAPTER=mastra
```

- [ ] **Step 2: Create `docker-compose.local.yml`**

```yaml
# Local overlay — developer machine. Publishes on 127.0.0.1; private source ON by default (URL only).
services:
  office-web:
    ports:
      - "127.0.0.1:${OFFICE_WEB_PORT:-8080}:80"
    restart: "no"
  office-server:
    ports:
      - "127.0.0.1:${OFFICE_SERVER_PORT:-8787}:8787"
    restart: "no"
    environment:
      OFFICE_PLATFORM_ENABLED: ${OFFICE_PLATFORM_ENABLED:-true}
    # Reach a trading-platform Ops Read API running on the host (Linux/WSL2 needs host-gateway).
    extra_hosts:
      - "host.docker.internal:host-gateway"
  ingress:
    restart: "no"
  worker:
    restart: "no"

  # OPTIONAL filesystem validation of the private runtime checkout.
  # NOT part of the default command. Enable explicitly: --profile private-path-check
  # Fails immediately if ${PRIVATE_RUNTIME_PATH} is absent (create_host_path:false) or empty.
  private-path-check:
    image: busybox:1.36
    profiles: ["private-path-check"]
    volumes:
      - type: bind
        source: ${PRIVATE_RUNTIME_PATH:-../trading-platform}
        target: /private-runtime
        read_only: true
        bind:
          create_host_path: false
    command: ["sh", "-c", "test -n \"$(ls -A /private-runtime 2>/dev/null)\" || (echo 'PRIVATE_RUNTIME_PATH missing or empty' >&2; exit 1)"]
    networks: [trading]
```

- [ ] **Step 3: Validate the local config merge (the gate)**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local.example config >/dev/null && echo "LOCAL OK"
```
Expected: `LOCAL OK`.

- [ ] **Step 4: Verify the path-check stays OFF by default**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local.example config --services | sort
```
Expected: lists `ingress migrate office-server office-web postgres redis worker` — **no** `private-path-check` (it is profile-gated).

- [ ] **Step 5: Commit**

```bash
git add .env.local.example docker-compose.local.yml
git commit -m "feat(docker): local overlay + env example (URL-only private source, optional path-check profile)"
```

---

## Task 7: VPS overlay + env example

**Files:**
- Create: `.env.vps.example`
- Create: `docker-compose.vps.yml`

- [ ] **Step 1: Create `.env.vps.example`**

```
# VPS — production-like, detached. Copy to .env.vps and fill the CHANGE_ME values.
# Run:
#   docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps up --build -d

COMPOSE_PROJECT_NAME=trading-vps

# Absolute checkout paths on the server.
TRADING_OFFICE_PATH=/opt/trading-office

# Publish address: 0.0.0.0 to expose directly, or 127.0.0.1 behind a host reverse proxy.
BIND_ADDR=0.0.0.0
OFFICE_WEB_PORT=8080
OFFICE_SERVER_PORT=8787

# Web UI (page) origin — used for office-server CORS.
OFFICE_CORS_ORIGIN=https://office.example.com
# Public office-server (API) origin baked into the web build (browser -> office-server).
# Typically a DIFFERENT origin from the UI. Same-origin variant: set both to the UI origin
# and have a reverse proxy route /api/office/* + the WS upgrade to office-server.
VITE_OFFICE_GATEWAY_URL=https://office-api.example.com

# trading-lab service-to-service tokens — placeholders only; NEVER commit real values.
TRADING_LAB_READ_TOKEN=CHANGE_ME
TRADING_LAB_CHAT_TOKEN=CHANGE_ME
TRADING_LAB_TASK_TOKEN=CHANGE_ME
TRADING_LAB_CALLBACK_TOKEN=CHANGE_ME

# Agents/platform: keep fake/mock unless deliberately enabling a real runtime.
TRADING_PLATFORM_INTEGRATION=mock

# Read-only private operational source (ON by default for vps).
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=http://internal-platform-host:8839
TRADING_PLATFORM_READ_TOKEN=CHANGE_ME

# Only used by the optional `--profile private-path-check` guard:
PRIVATE_RUNTIME_PATH=/opt/trading-platform
```

- [ ] **Step 2: Create `docker-compose.vps.yml`**

```yaml
# VPS overlay — production-like, detached (`up -d`). Restart policies on; bind via ${BIND_ADDR}.
services:
  postgres:
    restart: unless-stopped
  redis:
    restart: unless-stopped
  ingress:
    restart: unless-stopped
  worker:
    restart: unless-stopped
  office-web:
    ports:
      - "${BIND_ADDR:-0.0.0.0}:${OFFICE_WEB_PORT:-8080}:80"
    restart: unless-stopped
  office-server:
    ports:
      - "${BIND_ADDR:-0.0.0.0}:${OFFICE_SERVER_PORT:-8787}:8787"
    restart: unless-stopped
    environment:
      OFFICE_PLATFORM_ENABLED: ${OFFICE_PLATFORM_ENABLED:-true}
    extra_hosts:
      - "host.docker.internal:host-gateway"

  # OPTIONAL — same guard as local; enable with --profile private-path-check.
  private-path-check:
    image: busybox:1.36
    profiles: ["private-path-check"]
    volumes:
      - type: bind
        source: ${PRIVATE_RUNTIME_PATH:-/opt/trading-platform}
        target: /private-runtime
        read_only: true
        bind:
          create_host_path: false
    command: ["sh", "-c", "test -n \"$(ls -A /private-runtime 2>/dev/null)\" || (echo 'PRIVATE_RUNTIME_PATH missing or empty' >&2; exit 1)"]
    networks: [trading]
```

- [ ] **Step 3: Validate the vps config merge (the gate)**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps.example config >/dev/null && echo "VPS OK"
```
Expected: `VPS OK`.

- [ ] **Step 4: Verify restart policy + bind address applied**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps.example config | grep -E 'restart|published|host_ip' | head
```
Expected: `restart: unless-stopped` present; published 8080/8787 with `host_ip: 0.0.0.0`.

- [ ] **Step 5: Commit**

```bash
git add .env.vps.example docker-compose.vps.yml
git commit -m "feat(docker): vps overlay + env example (detached, restart policies, BIND_ADDR)"
```

---

## Task 8: Smoke script + Makefile

**Files:**
- Create: `scripts/smoke.sh`
- Create: `Makefile`

- [ ] **Step 1: Create `scripts/smoke.sh`**

```bash
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
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x scripts/smoke.sh
```

- [ ] **Step 3: Create `Makefile`**

```makefile
# Thin wrappers around the documented docker compose commands.
.PHONY: demo local vps down smoke config

demo: .env.demo
	docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build

local: .env.local
	docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up --build

vps: .env.vps
	docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps up --build -d

# Create the real env file from the example on first run.
.env.%:
	cp .env.$*.example .env.$*
	@echo ">> Created .env.$* from .env.$*.example — review it before production use."

down:
	-docker compose -f docker-compose.yml -f docker-compose.demo.yml down
	-docker compose -f docker-compose.yml -f docker-compose.local.yml down
	-docker compose -f docker-compose.yml -f docker-compose.vps.yml down

# Usage: make smoke MODE=demo
smoke:
	./scripts/smoke.sh $(MODE)

# Validate all three merges against the committed examples.
config:
	docker compose -f docker-compose.yml -f docker-compose.demo.yml  --env-file .env.demo.example  config >/dev/null && echo "demo OK"
	docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local.example config >/dev/null && echo "local OK"
	docker compose -f docker-compose.yml -f docker-compose.vps.yml   --env-file .env.vps.example   config >/dev/null && echo "vps OK"
```

- [ ] **Step 4: Verify `make config` passes for all three**

Run:
```bash
make config
```
Expected:
```
demo OK
local OK
vps OK
```

- [ ] **Step 5: Verify the smoke script is syntactically valid**

Run:
```bash
bash -n scripts/smoke.sh && echo "SMOKE SYNTAX OK"
```
Expected: `SMOKE SYNTAX OK`.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.sh Makefile
git commit -m "feat(docker): smoke-check script + Makefile wrappers"
```

---

## Task 9: Docs (demo / local / vps quickstarts)

**Files:**
- Create: `docs/docker-demo.md`
- Create: `docs/docker-local.md`
- Create: `docs/docker-vps.md`

- [ ] **Step 1: Create `docs/docker-demo.md`** (neutral — no private platform)

```markdown
# Docker Demo

Run the whole demo stack — the trading-lab backend plus the trading-office dashboard — with one command. The demo uses fake agents and sample data: no API keys, no exchange credentials, no live trading.

## Prerequisites

- Docker with Compose v2 (≥ 2.17).
- The `trading-office` checkout next to this repo (default `../trading-office`).
- `curl` (used by the smoke check).

## Quickstart

```bash
cp .env.demo.example .env.demo
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build
```

Then open the dashboard: <http://localhost:8080>

(Or use the shortcut: `make demo`.)

## What starts

| Service       | Role                                   | Reachable at |
|---------------|----------------------------------------|--------------|
| postgres      | trading-lab database                   | internal only |
| redis         | trading-lab queue                      | internal only |
| migrate       | one-shot schema migration              | — |
| ingress       | trading-lab ingress + read API + SSE   | internal only |
| worker        | trading-lab background worker          | internal only |
| office-server | dashboard backend (proxies the lab)    | http://localhost:8787 |
| office-web    | dashboard UI                           | http://localhost:8080 |

Only the dashboard UI and its API are published, bound to `127.0.0.1`. The database and lab services stay on the internal Docker network — the browser only ever talks to the office services.

## Smoke check

In another terminal:

```bash
make smoke MODE=demo
```

Expected: `[smoke:demo] PASS`.

## Stop

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo down
# add -v to also drop the database volume
```

## Notes

- The demo is fully self-contained — it needs nothing beyond this repo and the `trading-office` checkout.
- Default agents are fake. To use a real LLM, see `docs/docker-local.md`.
- Host-only infra (run `pnpm ingress` / `pnpm worker` on your machine): `docker compose up postgres redis`.
```

- [ ] **Step 2: Create `docs/docker-local.md`**

```markdown
# Docker Local

Local developer mode. Same stack as the [demo](./docker-demo.md), plus an **optional** read-only operational source from an already-running private runtime — wired by URL only. Docker never clones, mounts, builds, or runs the private runtime.

## Prerequisites

- Everything from the demo.
- (Optional) a running private operational read API (Ops Read) you can reach by URL.

## Quickstart

```bash
cp .env.local.example .env.local
# edit .env.local — see below
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up --build
```

Open <http://localhost:8080> (or `make local`).

## Optional private read-only source

In `.env.local`:

```
OFFICE_PLATFORM_ENABLED=true                              # on by default; false to run offline
TRADING_PLATFORM_READ_URL=http://host.docker.internal:8839
TRADING_PLATFORM_READ_TOKEN=<your ops-read token>
```

- `host.docker.internal` reaches a service running on your host; the overlay already adds the
  `host.docker.internal:host-gateway` mapping required on Linux/WSL2.
- If `OFFICE_PLATFORM_ENABLED=true` but the URL/token are missing, office-server fails fast at boot.
- Set `OFFICE_PLATFORM_ENABLED=false` to run local with no private source.

### Optional checkout path guard

To assert a private checkout exists on disk before starting (does not run any private code):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local \
  --profile private-path-check up
```

It fails immediately if `PRIVATE_RUNTIME_PATH` is missing or empty. This guard is **off** unless you pass the profile.

## Real LLM (optional)

Uncomment and set in `.env.local`:

```
MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-...
RESEARCHER_ADAPTER=mastra
```

## Smoke check

```bash
make smoke MODE=local
```

Probes the lab and office as in demo, and — only if `TRADING_PLATFORM_READ_URL` is set and reachable — the private Ops Read URL. It never starts the private runtime.
```

- [ ] **Step 3: Create `docs/docker-vps.md`**

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add docs/docker-demo.md docs/docker-local.md docs/docker-vps.md
git commit -m "docs(docker): demo/local/vps quickstarts"
```

---

## Task 10: Full demo bring-up + smoke (end-to-end gate)

**Files:** none (verification + temp `.env.demo`).

- [ ] **Step 1: Create the real demo env file**

Run:
```bash
cp .env.demo.example .env.demo
```
Confirm `TRADING_OFFICE_PATH=../trading-office` resolves to the office checkout (with the Task 3 Dockerfiles).

- [ ] **Step 2: Bring up the demo stack (build)**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build -d
```
Expected: all images build; `migrate` exits 0; `ingress` becomes healthy; office-server + office-web start.

- [ ] **Step 3: Wait for health, then check status**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo ps
```
Expected: `postgres`/`redis`/`ingress` healthy; `migrate` exited (0); `office-server`/`office-web` up.

- [ ] **Step 4: Run the smoke checklist (the gate)**

Run:
```bash
./scripts/smoke.sh demo
```
Expected: every line `✓` and final `[smoke:demo] PASS`.

- [ ] **Step 5: Confirm the dashboard serves and reaches lab data**

Run:
```bash
curl -fsS http://localhost:8080/ | grep -qi "<!doctype html" && echo "DASHBOARD HTML OK"
curl -fsS http://localhost:8787/api/office/agents/statuses | head -c 200; echo
```
Expected: `DASHBOARD HTML OK`; the second curl returns a JSON object (agent statuses proxied from the lab), not an error.

- [ ] **Step 6: Tear down**

Run:
```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo down
rm -f .env.demo
```
Expected: clean stop. (`.env.demo` is gitignored regardless.)

(No commit — verification only.)

---

## Task 11: Validate local/vps configs + push

**Files:** none (verification + push).

- [ ] **Step 1: Re-validate all three configs**

Run:
```bash
make config
```
Expected: `demo OK` / `local OK` / `vps OK`.

- [ ] **Step 2: Confirm no secrets or real env files are staged anywhere**

Run:
```bash
git status --porcelain
git ls-files | grep -E '^\.env\.(demo|local|vps)$' && echo "LEAK!" || echo "NO REAL ENV FILES TRACKED"
```
Expected: working tree clean; `NO REAL ENV FILES TRACKED`.

- [ ] **Step 3: Push the office branch**

Run:
```bash
git -C ../trading-office push -u origin docker-build-contract
```
Expected: branch pushed; PR-create URL printed.

- [ ] **Step 4: Push the lab branch**

Run:
```bash
git push
```
Expected: commits pushed to `origin/docker-orchestration`.

- [ ] **Step 5: Report**

Summarize: both branches pushed, demo verified end-to-end, local/vps `config`-validated. Offer to open the two PRs (lab + office) — note they must merge together (the lab demo build depends on the office Dockerfiles).

---

## Self-Review (performed during planning)

**Spec coverage:**
- §2 ownership → Tasks 2/3 (lab vs office Dockerfile homes). ✓
- §3 topology/ports (expose in base, ports in overlays) → Task 4 (expose) + Tasks 5/6/7 (overlay ports). ✓
- §4 file deliverables → all files have a task. ✓
- §5 base services → Task 4 (exact env, healthchecks, depends_on). ✓
- §6 read-api token gotcha → demo/local/vps envs all set `TRADING_LAB_READ_TOKEN` (Tasks 5/6/7); ingress healthcheck hits `/readyz`. ✓
- §7 gateway URL build-arg per mode → Task 3 web Dockerfile ARGs + base `office-web` build.args + env examples. ✓
- §8 URL-only private source + optional `--profile private-path-check` → Tasks 6/7; office-server has no dependency on the guard. ✓
- §9 mode overlays → Tasks 5/6/7. ✓
- §10 env examples → Tasks 5/6/7. ✓
- §11 secrets → `.gitignore` (Task 5) + Task 11 leak check. ✓
- §12 smoke → Task 8 + Task 10. ✓
- §13 host-dev back-compat → Task 4 Step 3. ✓
- §14 verification → Task 10 (demo up) + Task 11 (local/vps config). ✓
- §15 DoD → covered across tasks. ✓

**Placeholder scan:** No TBD/TODO; every file step contains full content; `CHANGE_ME` in `.env.vps.example` is an intentional operator placeholder, not a plan gap. ✓

**Type/name consistency:** Service names (`postgres`, `redis`, `migrate`, `ingress`, `worker`, `office-server`, `office-web`), env var names (`OFFICE_*`, `TRADING_LAB_*`, `TRADING_PLATFORM_*`, `VITE_OFFICE_*`), ports (8080 web / 8787 server / 3000+3100 lab), and the office API path (`/api/office/agents/statuses`) are identical across base, overlays, env examples, smoke script, and docs. ✓
