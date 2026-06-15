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
