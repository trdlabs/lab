# Sandbox execution topology — companion (trading-lab) дизайн

**Статус:** дизайн утверждён (2026-06-22).
**Контекст:** Часть B одной кросс-репо инициативы. Часть A (backtester core) уже смержена в `trading-backtester` main (PR #38): `MountSource` bind|volume, env-переключатель режима, доставка bundle+harness через общий named-том, docker CLI + overlay-harness в образе. Settled-брифинг и backtester-дизайн: `trading-backtester/docs/superpowers/specs/2026-06-22-sandbox-execution-topology-{analysis,design}.md`.
**Scope этой спеки:** только изменения в `trading-lab`. Два дельверабла: (A) demo compose-обвязка для DooD, (B) dev-оркестрация (minimal-docker) с backtester на host (native sandbox, без DooD).

## Контракт из Части A (фиксирован, потребляем как есть)

- **Имя тома:** `btx-sandbox` (env `BACKTESTER_SANDBOX_OVERLAY_VOLUME`).
- **Mountpoint в backtester:** `/sandbox-shared` (env `BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT`).
- **Сокет:** `/var/run/docker.sock` смонтирован в backtester.
- **Образ:** backtester-образ Части A несёт `docker` CLI и overlay-harness — собирается из `${TRADING_BACKTESTER_PATH:-../trading-backtester}`, отдельной правки образа не нужно.
- **Режим:** оба env-VOLUME заданы → volume-режим (DooD); ни один → bind-режим (dev, native docker). Ровно один → fail-fast в backtester при загрузке конфига.

## Текущее состояние (по коду, worktree off main e67a43c)

- `docker-compose.yml` (база): postgres, redis, ingress (3000+3100), migrate, worker, office-server, office-web. `backtester` в базе НЕТ; `volumes: { lab_pg }`.
- `docker-compose.demo.yml` (overlay): добавляет `mock-platform` (expose 8839) + `backtester` (build из `TRADING_BACKTESTER_PATH`, `BACKTESTER_ENABLE_OVERLAY_ENGINE=true`, `BACKTESTER_DATA_SOURCE=mock`, публикует `127.0.0.1:${BACKTESTER_HOST_PORT:-8081}:8080`). office-server несёт `OPERATOR_DOWNSTREAM_BACKTESTS=true`.
- `make demo` = `docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build`. `make config` валидирует merge против `.env.demo.example`.
- Process-manager в репо НЕТ. Host-команды: `pnpm ingress` / `pnpm worker` (через `node --experimental-strip-types`). mock-platform/postgres/redis портов на host НЕ публикуют (только `expose`/network).

## A. Demo compose-обвязка (`docker-compose.demo.yml`)

На сервис `backtester` добавить:

```yaml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # DooD: sandbox спавнится host-sibling'ом
      - btx-sandbox:/sandbox-shared                  # общая доставка bundle+harness
    environment:
      # …существующие…
      BACKTESTER_SANDBOX_OVERLAY_VOLUME: "btx-sandbox"
      BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT: "/sandbox-shared"
```

Top-level в `docker-compose.demo.yml`:

```yaml
volumes:
  btx-sandbox:
    name: btx-sandbox
```

**`name: btx-sandbox` — нагруженная корректность (ключевой момент).** Без пиннинга compose создаёт том как `<project>_btx-sandbox`. Backtester внутри контейнера делает `docker run --mount type=volume,src=btx-sandbox …` против **host-демона** — тот резолвит литеральное имя `btx-sandbox`. Если compose-том называется `trading-lab_btx-sandbox`, то:
- собственный mount backtester'а (`/sandbox-shared`) → `trading-lab_btx-sandbox` (туда пишутся bundle/harness),
- `docker run --mount src=btx-sandbox` → host-литерал `btx-sandbox` → ДРУГОЙ (авто-создаётся пустой) том,
→ sandbox видит пустой mount → падает. Пиннинг `name: btx-sandbox` заставляет оба пути резолвиться в один host-том. Обязателен.

Образ не трогаем (Часть A собирается из `TRADING_BACKTESTER_PATH`). Изменение в demo overlay (а не в базе), т.к. DooD — demo/vps-специфика.

**Риск (документируем):** монтирование host docker.sock даёт контейнеру backtester effective host-root. Приемлемо для demo/local/vps; для жёсткого prod — dind-sidecar или реальный sandbox-runtime (note-only, вне scope).

## B. Dev-оркестрация (minimal-docker, full-host)

Цель: быстрый dev-цикл с watch, где app-сервисы — host-процессы, а stateful-инфра — в docker. Backtester на host → его `docker run` бьёт по host-демону нативно (**bind-режим, без DooD, без path-aliasing**).

### B.1 `docker-compose.dev.yml` (новый)
Overlay, публикующий `127.0.0.1` host-порты для трёх инфра-сервисов (определения берутся из base+demo; здесь только `ports`), чтобы host-процессы их достали:
```yaml
services:
  postgres:      { ports: ["127.0.0.1:5432:5432"] }
  redis:         { ports: ["127.0.0.1:6379:6379"] }
  mock-platform: { ports: ["127.0.0.1:8839:8839"] }
```

### B.2 `.env.dev` + `.env.dev.example` (новые)
Host-localhost-проводка для всех host-сервисов:
- `DATABASE_URL=postgres://lab:lab@localhost:5432/trading_lab`, `REDIS_URL=redis://localhost:6379`
- `LAB_OPS_READ_URL=http://localhost:8839`, `LAB_OPS_READ_TOKEN`, `MOCK_OPS_TOKEN`/`MOCK_OPS_TOKENS` (пара как в demo)
- `TRADING_PLATFORM_INTEGRATION=backtester`, `BACKTESTER_API_URL=http://localhost:8080`, `BACKTESTER_API_TOKEN`
- `TRADING_LAB_CALLBACK_PUBLIC_URL=http://localhost:3000` (backtester постит сюда callback)
- backtester host: `BACKTESTER_DATA_SOURCE=mock`, `BACKTESTER_MOCK_PLATFORM_URL=http://localhost:8839`, `BACKTESTER_ENABLE_OVERLAY_ENGINE=true`, `BACKTESTER_PORT=8080`, **без** `BACKTESTER_SANDBOX_OVERLAY_VOLUME*` (→ bind-режим)
- office: `TRADING_LAB_READ_URL=http://localhost:3100`, `TRADING_LAB_CHAT_URL=http://localhost:3000`, `OPERATOR_DOWNSTREAM_BACKTESTS=true`, `TRADING_PLATFORM_READ_URL=http://localhost:8839`
- пути: `TRADING_OFFICE_PATH=../trading-office`, `TRADING_BACKTESTER_PATH=../trading-backtester`

`.env.dev.example` коммитим (как `.env.demo.example`); `.env.dev` создаётся из примера правилом `.env.%` и gitignore'ится.

### B.3 `mprocs.yaml` (новый)
`mprocs` как devDependency. Procs:
- `infra`: `docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev up postgres redis mock-platform` (только три инфра-сервиса; их `depends_on` пуст → app-сервисы не поднимаются).
- `ingress`: `node --watch --experimental-transform-types src/ingress/server.ts` (3000+3100).
- `worker`: `node --watch --experimental-transform-types src/worker/worker.ts`.

  **Флаг `--experimental-transform-types`, НЕ `--strip-types`.** Текущий исходник использует TS parameter properties, которые `--experimental-strip-types` (что делает `pnpm ingress`/`pnpm worker`) не парсит — поэтому compose уже переопределяет эти команды на `--experimental-transform-types` (docker-compose.yml §ingress/worker). Dev-процессы зеркалят это; запускать `pnpm ingress` напрямую нельзя (сломается на тех же parameter properties).
- `backtester`: `cd $TRADING_BACKTESTER_PATH && pnpm start` (bind-режим, native docker).
- `office-server`, `office-web`: dev-команды из `$TRADING_OFFICE_PATH` (точные команды — разрешаются в плане чтением `../trading-office/package.json`; vite dev для web).

Per-proc env берётся из `.env.dev` (mprocs `env`/`shell` с подгрузкой). Порядок старта: infra первым; host-сервисы стартуют параллельно, переживают рестарты infra (watch перезапускает только свой proc).

### B.4 `make dev` (новый target)
Бутстрап `.env.dev` из примера (правило `.env.%` уже есть) + запуск `mprocs`:
```make
dev: .env.dev
	mprocs
```

## Валидация / приёмка

- **Compose-конфиг:** расширить `make config` — дополнительно валидировать dev-merge:
  `docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev.example config -q`. Demo-merge (`make config` существующий) обязан остаться зелёным.
- **`mprocs.yaml`:** YAML-валидность + smoke (`mprocs --version` доступен после install). Полный прогон без всего стека не требуется.
- **Приёмка инициативы (DoD):** при Части A на main, `make demo` доводит **реальный research-backtest organically** — sandbox спавнится host-sibling'ом через сокет, читает bundle+harness из тома `btx-sandbox`, backtester постит `backtest-completed`, `trading-lab` достигает `backtest.completed` → `backtest.result_ready` → проактивное сообщение оператора (без `/tasks`-инъекции). `make dev` поднимает full-host цикл с нативным sandbox.

## Разрешается в плане
- Точные dev-команды office-server/office-web — чтением `../trading-office/package.json` (vite dev для web, dev/start для server). `make dev` предполагает наличие sibling-репозиториев office + backtester с установленными зависимостями — то же предположение, что уже делает compose `build` через `TRADING_*_PATH`.
- Точный синтаксис per-proc env в `mprocs.yaml` (загрузка `.env.dev`).

## Файлы (trading-lab scope)
- `docker-compose.demo.yml` — socket + том + 2 env на `backtester`; top-level `volumes: btx-sandbox{name}`.
- `docker-compose.dev.yml` (новый) — публикация портов инфры.
- `.env.dev.example` (новый, коммитим) + `.env.dev` (из примера, gitignore).
- `mprocs.yaml` (новый) + `mprocs` devDependency.
- `Makefile` — `dev` target (+ `config` расширить dev-валидацией).
- Вне scope: правки sibling-репозиториев (office/backtester) — потребляем как есть.

## Инварианты / out of scope
- Demo-режим — единственный, где появляется DooD/socket; dev — bind/native, prod (vps) — отдельно (можно повторить demo-обвязку в vps overlay позже, вне этой спеки).
- Не дублируем backtester-сервис в базу; DooD-обвязка живёт в demo overlay.
- `OPERATOR_DOWNSTREAM_BACKTESTS=true` уже включён на office-server demo (e67a43c) → organic `backtest.completed` доходит без `/tasks`.
