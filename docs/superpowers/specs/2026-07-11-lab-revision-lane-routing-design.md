# Lab — revision-lane routing + config hygiene (load-readiness slice 1)

Date: 2026-07-11.
Status: design approved, implementation pending.
Source: первый срез плана `docs/research/2026-07-11-lab-load-readiness-review.md`
(Этап 0 гигиена + Этап 1.1 сериализация ревизий). Скоуп выбран ортогональным
параллельному треку preservation-gate / hypothesis-eval (R1–R14).

## 1. Цель и не-цель

**Цель:** развязать конвейер задач по классам, вынеся линию ревизий
(`revision.build`, `revision.consolidate`) в отдельную BullMQ-очередь со своим воркером,
и попутно закрыть дешёвую конфиг-гигиену Этапа 0. Это структурный фундамент под будущий
подъём параллелизма (Этапы 1.2/1.4) и снятие head-of-line-блокировки между линией ревизий
и остальными задачами.

**Не-цель (важно для честности):** это **не** целевой throughput lift и **не** финальная
модель нагрузки. Срез повышает общий процессный параллелизм с 1 до 2 (один default-task +
один revision-task одновременно) и — как следствие — редкое межlane-пересечение давления
на backtester (см. §4). Полное ограничение суммарного backtester in-flight переносится в
Этап 1.4 (общий семафор).

## 2. Скоуп

**В срезе:**
- 1.1 — `RoutingQueueAdapter` + `routeTaskType` + разводка; две очереди.
- 0.1 — док настоящей причины concurrency-ограничений в `.env.example`.
- 0.2 — фикс стейл-коммента `RESEARCH_TASK_TOKEN_BUDGET`.
- 0.3 — проброс concurrency-переменных в compose worker-сервис (**без healthcheck**).
- 0.6 — env-knob `LAB_PG_POOL_MAX`.

**Вне среза (следующие срезы):**
- 0.4 — инкремент `envelope.attempt` + запись в `agent_event`. Причина выноса: текущий
  generic worker-lifecycle пишет только `research_task.updateStatus` (running/completed/
  failed), agent_event lifecycle-события в нём не эмитятся. Один `attempt` в envelope без
  наблюдаемого консьюмера не стоит отдельного изменения. Правильное место — health/
  observability-срез, где всё равно добавляются lifecycle-события и меняется lifecycle API
  (`process(): Promise<void>`).
- 0.5 — reconciler зависших задач (own migration + sweep).
- 1.2 — классы очередей fast/heavy/revision.
- 1.4 — семафор на сабмиты в backtester.
- worker health/readiness + смена `TaskQueuePort.process` на async-контракт.

## 3. Архитектура

### 3.1 Компоненты

```
type QueueLane = 'default' | 'revision';

routeTaskType(taskType: string): QueueLane
  // 'revision.build' | 'revision.consolidate'  -> 'revision'
  // всё остальное, включая неизвестный string  -> 'default'

class RoutingQueueAdapter implements TaskQueuePort
  // Map<QueueLane, BullMqQueueAdapter>
  // enqueue(envelope, opts) -> sub-adapter по routeTaskType(envelope.taskType)
  // process(handler)        -> регистрирует воркеров во ВСЕХ lane (один общий handler)
  // close()                 -> закрывает все sub-adapters, AggregateError при частичном сбое
```

- `routeTaskType` — чистая функция, единственная точка политики роутинга. Принимает
  `string` (не union), чтобы неизвестный тип реально тестировался и уходил в `'default'`.
- `RoutingQueueAdapter` реализует существующий `TaskQueuePort` байт-в-байт по сигнатуре —
  поэтому все call-site'ы `enqueue` и composition не меняются, меняется только конкретный
  класс, который строит composition.
- `BullMqQueueAdapter` **не меняется** — остаётся примитивом на одну BullMQ-очередь. Его
  существующие тесты не трогаются.

### 3.2 Очереди

Две BullMQ-очереди: `research-tasks` (default) и `research-tasks-revision`.

### 3.3 Разводка

- И ingress (producer), и worker строят `RoutingQueueAdapter` через `composeRuntime`.
- Только worker-процесс вызывает `process()` — теперь он поднимает **двух** воркеров
  (по одному на lane), оба с одним и тем же `router.dispatch`-handler.
- ingress открывает только producer-соединения обеих очередей, воркеров не поднимает.

### 3.4 Инвариант дедупликации

DB-дедуп (`findByDedupeKey` в `task-intake`) очередь-агностичен — не меняется. BullMQ
`jobId` уникален внутри очереди; каждый `taskType` детерминированно роутится ровно в одну
очередь, поэтому кросс-очередных коллизий `jobId` нет.

## 4. Concurrency и bounded-risk overlap

`revision.build` обязан уйти в revision-lane, потому что именно там живёт race по
`UNIQUE(profile, version)`. Это сознательно вводит временный bounded-risk overlap: при
`LAB_QUEUE_CONCURRENCY=1` и `LAB_REVISION_QUEUE_CONCURRENCY=1` один default-task и один
revision-task могут одновременно сабмитить backtest runs. Значит, общий процессный
параллелизм растёт с 1 до 2, а пиковое давление на backtester может временно превысить
прежний контракт. Это не целевой throughput lift и не финальная модель нагрузки; это
архитектурная развязка head-of-line и revision-race. Полное ограничение суммарного
backtester in-flight переносится в 1.4 через общий семафор.

Почему overlap приемлем: `revision.build` редок (фаер только при терминировании
correlation-цепочки), его acceptance-бэктесты немногочисленны, а backtester очередит
внутри (нет ingress-backpressure → не отказ, а рост латентности). Окно закрывается на 1.4.
`revision.consolidate` для контекста LLM-bound — сам новых бэктестов не сабмитит
(сравнивает против существующего run-context; re-baseline уходит в `strategy.baseline` на
default-lane).

**Guard до следующих срезов (только докой, без runtime-валидации на этом срезе):**
- `LAB_REVISION_QUEUE_CONCURRENCY` — default **1**, documented **must-stay-1 до 1.5**
  (retry-on-conflict, который делает race неразрушающей).
- `LAB_QUEUE_CONCURRENCY` — default **1**, documented **must-stay-1 до 1.4** (общий
  backtester-семафор).
- Поднимать любую из них без общего backtester-семафора нельзя, потому что **оба lane
  содержат backtester-submitters**.

## 5. Config surface

| Переменная | Дефолт | Управляет | Ограничение |
|---|---|---|---|
| `LAB_QUEUE_CONCURRENCY` | 1 | default-lane worker concurrency | must-stay-1 до 1.4 |
| `LAB_REVISION_QUEUE_CONCURRENCY` | 1 | revision-lane worker concurrency | must-stay-1 до 1.5 |
| `LAB_PG_POOL_MAX` | 10 | `pg.Pool({ max })` в `createDbClient` | invalid/zero → fallback 10 |

`.env.example` (0.1) — блок у обеих concurrency-переменных с настоящей причиной: обе lane =
backtester-submitters; поднимать без семафора 1.4 нельзя; revision-lane также держит race
по `UNIQUE(profile,version)` до 1.5.

`.env.example` (0.2) — коммент `RESEARCH_TASK_TOKEN_BUDGET`: «unset = 200000 (default),
`0` = unlimited» (по `loadEnv` в `src/config/env.ts`), вместо стейл «Unset = unlimited».

## 6. Обработка ошибок и жизненный цикл

- Бросок handler'а → per-queue BullMQ-поведение не меняется (attempts 3, exp backoff base
  1000ms); retry идемпотентен через `resumeToken` / `dedupeKey`.
- `RoutingQueueAdapter.process()` **регистрирует** воркеров всех lane синхронно. Синхронный
  сбой регистрации любой lane пробрасывается и валит boot. **`process()` не обещает
  Redis-ready** — регистрация воркера ≠ доказательство, что он реально потребляет (Redis-
  соединение часто падает асинхронно). Полная async-readiness проверка worker lanes —
  отдельный health/readiness-срез; здесь ложного readiness-контракта не создаём.
- `RoutingQueueAdapter.close()` закрывает **все** sub-adapters; частичный сбой закрытия
  одного не должен глотать остальные — собрать ошибки и бросить `AggregateError` (без
  short-circuit).
- `routeTaskType` для неизвестного `taskType` → `'default'` (безопасный фолбэк, не бросаем).

## 7. Тесты

- unit `routeTaskType`: `revision.*` → `revision`; все прочие зарегистрированные типы →
  `default`; неизвестный `string` → `default`; exhaustiveness по всем зарегистрированным
  таскам.
- unit `RoutingQueueAdapter.enqueue`: выбор правильной очереди + passthrough
  `delayMs`/`dedupeKey`.
- unit `RoutingQueueAdapter.process()`: handler зарегистрирован на **обеих** lane.
- unit `RoutingQueueAdapter.close()`: закрывает все sub-adapters; `AggregateError` при сбое
  одного.
- config-assert: revision sub-adapter построен с `workerConcurrency: 1`. **НЕ**
  интеграционный BullMQ-тест последовательности — порядок исполнения при concurrency=1 не
  наша логика.
- (опц.) через fake process-runner: revision-lane не зовёт >1 handler одновременно.
- 0.6: `LAB_PG_POOL_MAX` — валидное значение применяется; invalid/zero → fallback 10.

## 8. Пофайловый список изменений (ориентир для реализации)

- **new** `src/adapters/queue/route-task-type.ts` — `QueueLane` + `routeTaskType`.
- **new** `src/adapters/queue/routing-queue.adapter.ts` — `RoutingQueueAdapter`.
- **new** тесты рядом (`*.test.ts`) по §7.
- `src/composition.ts` — строить `RoutingQueueAdapter` (обе lane, обе concurrency-
  переменные) вместо прямого `BullMqQueueAdapter`.
- `src/config/env.ts` — распарсить `LAB_REVISION_QUEUE_CONCURRENCY` (positive int, деф. 1)
  и `LAB_PG_POOL_MAX` (positive int, деф. 10, invalid/zero → 10).
- `src/db/client.ts` — `new Pool({ connectionString, max })`.
- `.env.example` — 0.1 + 0.2.
- `docker-compose.yml` — worker-сервис: проброс `LAB_QUEUE_CONCURRENCY` +
  `LAB_REVISION_QUEUE_CONCURRENCY`.
- `src/worker/worker.ts` — при необходимости обновить лог/wiring под два воркера (сам
  `startWorker` вызывает `queue.process`, который теперь поднимает обе lane — правок логики
  минимум).

## 9. Порядок относительно параллельного трека

`revision-build.handler.ts` уже несёт слайс 1a preservation-gate (в main, PR #147). Этот
срез его **не трогает** — меняется только транспорт/роутинг очередей, не доменная логика
ревизий. Срез 1.5 (retry-on-conflict в revision-build) осознанно отложен, чтобы сесть
поверх того, что сделают слайс 1b и R1/R3 с revision/hypothesis-линией.
