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

- Демо по умолчанию использует реальный срез из 5 символов (ESPORTSUSDT, HUSDT, SIRENUSDT, BEATUSDT, COAIUSDT), 73 сделки. Снапшот задаётся переменной `MOCK_SNAPSHOT_REF` (по умолчанию `fixtures/2026-06-12-real-top5`); для синтетических данных используй `fixtures/2026-06-16-synthetic`.
- The demo is fully self-contained — it needs nothing beyond this repo and the `trading-office` checkout.
- Default agents are fake. To use a real LLM, see `docs/docker-local.md`.
- Host-only infra (run `pnpm ingress` / `pnpm worker` on your machine): `docker compose up postgres redis`.
- The lab containers run with `node --experimental-transform-types` (not `--experimental-strip-types`) because the current source contains TS syntax (parameter properties) unsupported by strip-only mode. This is an infra-contained workaround; source cleanup is deferred to a separate change.
