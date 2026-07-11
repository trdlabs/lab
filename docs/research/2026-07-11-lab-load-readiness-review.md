# Lab load-readiness review: узкие места под нагрузкой и план их устранения

Дата: 2026-07-11.
Метод: графовая ориентация (gortex) + четыре независимых исследовательских прохода по коду
(очередь/воркеры, оркестрация, персистентность, LLM-слой + деплой). Все утверждения ниже
подкреплены ссылками `file:line` на текущий `main`. Анализ только — код не менялся.

Контекст: производительность backtester и platform уже подтянута; вопрос — готов ли lab
к росту числа бэктестов и (гипотетически) к массовому использованию. Заодно сверяем
выводы стороннего анализа (Perplexity Deep Research).

---

## 1. Вердикт (TL;DR)

**Главное узкое место lab — не инфраструктура, а доменная сериализация.** BullMQ, Postgres
и разделение ingress/worker уже готовы к горизонтальному росту. Но вся система сегодня
опирается на один глобальный тормоз — `LAB_QUEUE_CONCURRENCY=1` — который решает сразу три
задачи, ни одну из которых нельзя снять простым «поднять до 10»:

1. **Сериализует конвейер ревизий.** При concurrency>1 два `revision.build` по одному
   профилю гонятся за `UNIQUE(strategy_profile_id, version)`; проигравший **молча
   выбрасывает весь батч** proxy-passed гипотез (`revision.skipped {reason:
   'concurrent_revision'}`), а не повторяет попытку. Гвард корректный (не портит данные),
   но lossy.
2. **Ограничивает давление на backtester.** Контракт «`LAB_QUEUE_CONCURRENCY ×
   RESEARCH_GRID_CONCURRENCY ≤ WORKER_CONCURRENCY бэктестера`» живёт только в комментарии
   `.env.example` — ни один код его не enforce'ит («The backtester has no ingress
   backpressure yet — raise these deliberately»).
3. **Маскирует отсутствие приоритетов.** Очередь одна (`research-tasks`), без priority,
   без rate limiter, без разделения по типам — при concurrency=1 это незаметно, при >1
   станет источником head-of-line-блокировок.

Совет Perplexity «достаточно поднять LAB_QUEUE_CONCURRENCY=10 и запустить несколько
воркеров, инфраструктура готова» — **неверен и опасен**: он приводит к тихой потере
результатов исследований (п. 1) и к перегрузке бэктестера (п. 2). Правильный порядок:
сначала перевести сериализацию с «глобальной» на «per-strategy-profile» (по сути —
actor-модель: один почтовый ящик на профиль, параллельность между профилями), затем
разделить очереди по классам задач, и только потом крутить concurrency и реплики.

Хорошие новости, которые сторонний анализ не увидел: токен-бюджет уже в Postgres
(кросс-процессный), дедупликация двухслойная и держится на unique-констрейнтах БД
(работает между процессами), webhook-resume для долгих бэктестов уже реализован как
escape valve, Redis-история задач ограничена (`removeOnComplete: 1000`), а рекуррентный
`paper.monitor` — replica-safe.

---

## 2. Фактическая архитектура исполнения

### 2.1 Процессы и контейнеры

Lab — это **два процесса из одного образа** (не «single worker process», как утверждал
Perplexity):

- `ingress` — `src/ingress/server.ts`: три Hono-листенера в одном процессе (ingress :3000,
  read API :3100, chat смонтирован в ingress). Составляет runtime через `composeRuntime()`,
  но BullMQ-адаптер использует **только как producer** — `process()` не вызывается.
- `worker` — `src/worker/worker.ts:13-42`: единственный consumer очереди; generic-жизненный
  цикл `updateStatus('running') → router.dispatch → 'completed'/'failed'`.
- docker-compose: по одному инстансу каждого, `deploy.replicas` нигде нет; у worker нет
  healthcheck. **`LAB_QUEUE_CONCURRENCY` в env worker-контейнера не прокинут** — контейнер
  всегда работает на дефолте 1, что бы ни стояло в `.env`.

### 2.2 Очередь

Один `BullMqQueueAdapter` (`src/adapters/queue/bullmq-queue.adapter.ts`), одна очередь
`research-tasks` (`src/composition.ts:338`). Job options (`enqueue`, строки 52-63):
`attempts: 3`, exponential backoff 1000ms, `removeOnComplete: 1000`, `removeOnFail: 5000`,
`jobId = toBullmqJobId(dedupeKey ?? taskId)`. Нет `priority`, нет `limiter`, нет
`repeat`/cron. Concurrency воркера — `LAB_QUEUE_CONCURRENCY`, default 1
(`src/config/env.ts:227`).

Дедупликация двухслойная: первичная — DB (`findByDedupeKey` в
`src/orchestrator/task-intake.ts:35-41`, unique `research_task_dedupe_key_uq`), вторичная —
BullMQ jobId (`:` → `_`, известный gotcha кодифицирован в `toBullmqJobId`).

### 2.3 Конвейер задач (11 типов, регистрация `src/composition.ts:468-478`)

```
strategy.onboard ─(chain-runner)─▶ strategy.baseline ─▶ strategy.wfo ─▶ paper.start ─▶ paper.monitor ⟲
research.run_cycle ─▶ N × hypothesis.build ─▶ backtest.completed
                                   └─[poll исчерпан]─ webhook /callbacks ─▶ backtest.resume ─▶ backtest.completed
backtest.completed ─▶ [retry, depth<2, в бюджете] research.run_cycle
                  └─▶ [цепочка завершена] revision.build ─▶ [depth≥порога] revision.consolidate ─▶ strategy.baseline
paper.monitor ─▶ [window_complete] research.run_cycle {paperRunId}   ← замыкание Цикла 2
```

Классификация по длительности:
- **Долгие LLM-bound**: `research.run_cycle` (2 прохода researcher + critic на каждую
  гипотезу), `hypothesis.build` (builder LLM + сабмит + poll ≤60с), `revision.consolidate`,
  `strategy.onboard`.
- **Долгие backtest/IO-bound**: `strategy.baseline`, `strategy.wfo` (сетка × фолды,
  минуты), `revision.build` (acceptance-бэктесты), `backtest.resume` (poll ≤60с).
- **Короткие DB-only**: `backtest.completed`, `paper.start`, `paper.monitor`.

Все 11 типов делят один воркер-слот. Poll бэктеста (`pollOverlayRun`, дефолт 30×2000мс ≈
60с, `src/config/env.ts:223-224`) **удерживает слот** — промис хендлера висит до конца
poll'а (`src/worker/worker.ts:13-43`). WFO прогоняет всю сетку (`ParamGridRunner`,
`RESEARCH_GRID_CONCURRENCY=4`, `src/composition.ts:383`) **внутри одного слота** — задача
занимает воркер на минуты.

Отдельная деталь: в dispatch-петле `research.run_cycle`
(`src/orchestrator/handlers/research-run-cycle.handler.ts:396-445`) enqueue гипотез —
fire-and-forget (параллелизм возможен), но при включённом критике **внутри той же петли
await'ится `critic.review()` на каждую гипотезу** — диспетч гипотезы N+1 ждёт LLM-ревью
гипотезы N.

### 2.4 Конкурентность и состояние

- **Транзакций нет вообще** (`.transaction(` — 0 вхождений), `FOR UPDATE` / advisory locks —
  0. Вся конкурентность — unique-констрейнты как idempotency-гварды:
  `research_task_dedupe_key_uq`, `backtest_run_idem_uq`, `strategy_revision_profile_version_uq`,
  `paper_submission_idempotency_uq` и др. Это **кросс-процессно корректно** (гвард — в
  Postgres), но для ревизий — lossy (см. §4.2).
- **Токен-бюджет — в Postgres**: `research_token_usage` (PK correlation_id), атомарный
  `cumulativeTokens + N` через `onConflictDoUpdate`
  (`src/adapters/repository/drizzle-token-usage.repository.ts:13-24`). Гейт «между
  циклами» (`withinTokenBudget`), не прерывает in-flight вызов. Общий для всех процессов —
  вопреки предположению, что это надо чинить перед масштабированием.
- **In-memory состояние, которое реально мешает масштабированию, — на стороне ingress, не
  worker**: `AgentActivityProjection` — проекция в памяти, ребилд из хвоста `agent_event`
  при буте + live-фид через выделенный Postgres LISTEN-клиент; `src/read-api/README.md:28`
  прямо: «v1 assumes a single read instance».
- Chat plan / action proposal / сессии — всё в БД (никаких memory-держателей диалога).
- `LocalFileArtifactStore` (`src/adapters/artifact/local-file-artifact-store.adapter.ts`) —
  CAS на локальной ФС, `file://` URI ⇒ **допущение одного хоста / общего volume**; GC/квот
  нет.

### 2.5 Точки роста данных

Без TTL/прунинга растут: `agent_event` (append-only по дизайну), `research_task`,
`backtest_run`/`strategy_backtest_run`, evaluations, experiments, `action_proposal`
(протухшие помечаются лениво при чтении, но не удаляются), артефакты CAS. Ограничено
только в Redis (removeOnComplete/Fail). Индекса по `research_task.status` нет.

### 2.6 LLM-слой

`resolveLanguageModel` (`src/adapters/llm/model-provider.ts:41-56`) передаёт провайдеру
только `apiKey` — **ни `maxRetries`, ни fetch-обёртки, ни лимитера**. Ретраи 429 — что бы
ни делал AI SDK по умолчанию (maxRetries=2, в коде не сконфигурировано). Семафоров вокруг
LLM-вызовов нет. Mastra-агенты — синглтоны с бута (`composeMastra`), без per-request
состояния; Phoenix-трейсинг при `PHOENIX_ENABLED=false` не аллоцируется вовсе.

### 2.7 HTTP-поверхность

Hono + `@hono/node-server`. Fail-closed bearer на каждую границу (4 токена, 503 при
незаданном). **Нет body-limit, нет server/socket timeouts.** `POST /chat/messages` держит
LLM-вызов TurnInterpreter **внутри HTTP-запроса** (`src/chat/chat-handler.ts:147`).
Callback-ingress: bearer → zod → статус-чек → dedupe `backtest.resume:${runId}`; повторные
коллбэки схлопываются, но **аутентифицированный флуд с выдуманными runId не ограничен
ничем**, кроме цены одного DB-lookup на запрос.

---

## 3. Сверка с анализом Perplexity

| # | Утверждение Perplexity | Вердикт | Факт |
|---|---|---|---|
| 1 | Dispatch гипотез в builder уже параллельный (enqueue всех сразу) | ✅ Верно, с оговоркой | Enqueue fire-and-forget, но critic review await'ится последовательно в той же петле (`research-run-cycle.handler.ts:396+`) |
| 2 | `LAB_QUEUE_CONCURRENCY` default = 1 | ✅ Верно | `env.ts:227` |
| 3 | «Достаточно поднять до 10 и запустить несколько воркеров — инфраструктура готова» | ❌ **Неверно** | (а) revision race → тихая потеря батчей гипотез; (б) контракт давления на backtester не enforce'ится; (в) compose даже не прокидывает переменную в worker |
| 4 | `RESEARCH_GRID_CONCURRENCY` default = 4, sweep есть в WFO | ✅ Верно | `env.ts:226`, `composition.ts:383` |
| 5 | Sweep по параметрам гипотезы не подключён, seam есть | ✅ Верно | `hypothesis.build` гоняет одну пару baseline vs variant |
| 6 | Single worker process, один цикл блокирует всё | ⚠️ Наполовину | Процесса **два** (ingress+worker уже разделены); но head-of-line-блокировка при дефолтах — правда |
| 7 | Нет приоритизации / разделения очередей | ✅ Верно | Одна очередь, ни `priority`, ни `limiter` в JobsOptions |
| 8 | Нет tenant_id / multi-tenancy | ✅ Верно | 0 вхождений; только сервисные bearer-токены на границах |
| 9 | Нет LLM rate limiting, будут 429 | ✅ Верно | `model-provider.ts` не конфигурирует ничего |
| 10 | Token budget per correlation chain | ✅ Верно, и лучше | Он уже DB-backed и кросс-процессный — «чинить перед масштабированием» не надо |
| 11 | Один Pool, при 100 воркерах — 1000 соединений, нужен PgBouncer | ⚠️ Преждевременно | `new Pool({connectionString})` без опций (`src/db/client.ts:7-11`), node-pg max=10 **на процесс**. Сегодня процессов два — проблемы нет. PgBouncer — только при десятках процессов; сначала нужен просто env-knob на `max` |
| 12 | `agent_event` без TTL — нужен pruning | ✅ Верно, и шире | Прунинга нет нигде: tasks, runs, proposals, артефакты. Redis при этом ограничен |
| 13 | «OCC + Redlock» как улучшение | ❌ Мимо | Redlock не нужен: конкурентность уже держится на Postgres unique-констрейнтах (строже и проще). Правильный фикс — per-profile сериализация, а не распределённые локи |
| 14 | Mastra Workflow не подходит для оркестрации, Saga через BullMQ — правильный выбор | ✅ Согласен | Подтверждаю: webhook-resume + resumeToken + dedupe — грамотная реализация; миграция на Mastra suspend/resume ничего не даст под нагрузкой |

**Что Perplexity пропустил** (и что важнее половины его пунктов):

- Причину, по которой concurrency=1 — это не «настройка по умолчанию», а **несущая
  конструкция** конвейера ревизий (§4.2). Его совет №1 напрямую её ломает.
- Poll удерживает воркер-слот до 60с; у WFO — вся сетка в одном слоте минутами (§4.3).
- In-memory read-проекция в ingress — единственный настоящий «anti-scale» стейт (§4.6).
- `file://`-CAS артефактов — блокер мультихостового воркера (§4.5).
- Отсутствие транзакций как осознанный стиль (unique-констрейнты) — и его границы.
- Chat LLM внутри HTTP-запроса, отсутствие body-limit/timeout'ов.
- Разрыв «DB-строка создана, Redis-job не встал»: intake сначала пишет task, потом
  enqueue; reconciler'а для застрявших `queued` нет (есть только ручной
  `paper-monitor-resume` для одной lane).

---

## 4. Узкие места, ранжированные

### 4.1 🔴 Одна очередь без классов и приоритетов + глобальный concurrency=1

Все 11 типов задач — от 6-часового тика `paper.monitor` до многоминутного `strategy.wfo` —
в одной FIFO-очереди с одним слотом. Следствия: короткий `backtest.completed` (закрытие
цикла!) ждёт, пока досчитается чужой WFO; болтается latency всего конвейера; невозможно
дать чату/онбордингу быструю полосу.

### 4.2 🔴 Конвейер ревизий: single-writer per profile, гвард lossy

`revision.build` читает head (`findLatestAccepted`, `revision-build.handler.ts:157`),
строит `version = head + 1` и вставляет; проигравший гонку по
`UNIQUE(strategy_profile_id, version)` эмитит `revision.skipped {concurrent_revision}` и
**выходит, выбрасывая батч** (`revision-build.handler.ts:255-266`; тот же паттерн в
`revision-consolidate.handler.ts:58`). При глобальном concurrency=1 гонка невозможна —
поэтому и держим 1. Явного «must stay 1» в репо нет — знание живёт в PR #133 и командной
памяти (**документационный долг**).

Это классическая задача на **актора**: сериализовать нужно не всю систему, а работы над
одним `strategyProfileId`. Параллельность между профилями безопасна уже сейчас.

### 4.3 🔴 Воркер-слот занят ожиданием чужой работы

- Inline-poll бэктеста: до 30×2с на сабмит, при том что webhook-resume уже существует как
  штатный путь. Poll — это страховка, ставшая основным механизмом.
- `strategy.wfo`/`strategy.baseline`/`revision.build`: сетка `points × folds` бэктестов
  выполняется целиком внутри одного слота (`ParamGridRunner` + inline poll на каждую
  точку). Одна WFO-задача ≈ минуты монопольного владения воркером.

**Проверено (закрывает бывший открытый вопрос №1): webhook-resume реально покрывает
только hypothesis.build-lane.** Три подтверждённых факта:

1. **Strategy-lane (WFO-сетка, baseline) не находится callback'ом.** Оба executors
   передают `callbackUrl` и пишут ран как `submitted` с `resumeToken`
   (`backtester-strategy-experiment-run-executor.ts:48-85`), но callback-lookup привязан
   только к `services.backtests.findByPlatformRunId` — таблице `backtest_run`
   (`src/ingress/server.ts:13`). Раны strategy-lane лежат в `strategy_backtest_run` →
   `run_not_found`, resume-задача не ставится.
2. **Experiment-lane раны в `backtest_run` находятся, но resume скипается.**
   `BacktesterExperimentRunExecutor` пишет `taskId: req.experimentId`, а `experimentId =
   newId('exp')` (`experiment-service.ts:139`) — это id `research_experiment`, не
   `research_task`. `resumePlatformRun` делает `researchTasks.findById(taskId)` → null →
   `skipped {reason: 'task_not_found'}` (`resume-platform-backtest.ts:36-38`). Тот же
   скип получит и batch-CLI `platform-resume` (`resumePendingPlatformRuns` перебирает ту
   же таблицу).
3. **Даже успешный resume экспериментам не помог бы — они не ждут.**
   `runNewStrategyValidation`: `pending` любого члена → немедленный вердикт
   `INCONCLUSIVE ('run_pending')` (`experiment-service.ts:164,178,185`). `runGrid`:
   `pending`-точка считается как `rejected` и выпадает из ранжирования
   (`param-grid-runner.ts:76-78`). Точки повторной интеграции позднего результата в
   эксперимент нет.

Следствие: poll-бюджет 30×2с — **жёсткий дедлайн** для всех experiment-lanes; ран, не
уложившийся в ~60с, теряется для эксперимента (INCONCLUSIVE / выпавшая точка сетки), хотя
на платформе досчитывается и остаётся `submitted` в БД навсегда. Это и сегодняшний риск
(медленный бэктест → ложный INCONCLUSIVE), и ограничение на рекомендацию 1.3.

### 4.4 🟡 Контракт давления на backtester не enforce'ится

Правило `LAB_QUEUE_CONCURRENCY × RESEARCH_GRID_CONCURRENCY ≤ backtester
WORKER_CONCURRENCY` — комментарий в `.env.example`, не код. Как только concurrency
поднимется, произведение перестанет сходиться с ёмкостью бэктестера, а у того «no ingress
backpressure yet». Нужен семафор вокруг `submitOverlayRun` (max in-flight submissions),
общий для всех воркеров.

### 4.5 🟡 Артефакты: `file://` CAS без GC

Транспорт бандлов lab↔backtester — общая директория `.artifacts` (ecosystem-конвенция,
слайс 066). Для реплик воркера на одном хосте — ок (общий volume); для мультихоста —
блокер. Порт (`ArtifactStorePort`) уже есть, нужен только S3/MinIO-адаптер. GC нет — CAS
растёт вечно.

### 4.6 🟡 Ingress масштабируется хуже воркера

- `AgentActivityProjection` — in-memory, single-instance by design (`read-api/README.md:28`).
- Chat держит LLM в запросе (`chat-handler.ts:147`) — при медленном провайдере копятся
  висящие соединения; timeout'ов и body-limit нет.
- Callback-флуд ограничен только bearer'ом и ценой DB-lookup.

### 4.7 🟡 LLM-слой: нет лимитера и явной retry-политики

Никакого token-bucket / семафора / 429-обработки; `maxRetries` не задан (наследуется
дефолт AI SDK). При параллельных воркерах × параллельных гипотезах — прямой путь к 429 от
OpenRouter/Anthropic. Бюджет (kill-switch) есть, но это защита от расхода, не от rate limit.

### 4.8 🟢 Гигиена (не блокеры, но дешёвые дыры)

- compose не прокидывает `LAB_QUEUE_CONCURRENCY` в worker; у worker нет healthcheck.
- `envelope.attempt` захардкожен `1` (`task-intake.ts:57-63`) — ретраи BullMQ не видны в
  событиях.
- Стейл-коммент в `.env.example`: «Unset = unlimited» для `RESEARCH_TASK_TOKEN_BUDGET`,
  тогда как unset → 200000 (`env.ts:263`).
- Нет reconciler'а для задач, застрявших в `queued` (умер процесс между DB-insert и
  enqueue) — есть только ручной `paper:monitor:resume` для одной lane.
- `parseRedisUrl` не умеет TLS/sentinel/cluster — потолок для managed-Redis в будущем.
- Пул Postgres без `max`-knob'а; нет индекса `research_task(status)`.
- Прунинг: `agent_event`, `action_proposal`, артефакты.

---

## 5. Рекомендации (поэтапно; реализация — задачи для «дешёвой» модели)

Принцип: **сначала снять доменную сериализацию, потом делить очереди, потом крутить
масштаб.** Обратный порядок (как у Perplexity) теряет данные.

### Этап 0 — гигиена и наблюдаемость (S, можно сразу)

| # | Задача | Заметки |
|---|---|---|
| 0.1 | Задокументировать в `.env.example` + `docs/` настоящую причину `LAB_QUEUE_CONCURRENCY=1` (revision race, §4.2) | Сейчас знание только в PR #133/памяти |
| 0.2 | Починить стейл-коммент про `RESEARCH_TASK_TOKEN_BUDGET` | `env.ts:263` — истина |
| 0.3 | Прокинуть `LAB_QUEUE_CONCURRENCY` в env worker-сервиса compose; добавить healthcheck worker'у | Иначе Этап 1 не включится в контейнерах |
| 0.4 | Инкрементить `envelope.attempt`; писать attempt в agent_event | Дешёвая наблюдаемость ретраев |
| 0.5 | Reconciler застрявших задач: sweep по `research_task` в `queued`/`running` старше T → re-enqueue по dedupeKey (идемпотентно по построению) | Обобщение `paper-monitor-resume`; заодно индекс на `status` |
| 0.6 | Env-knob на `Pool({max})` | `src/db/client.ts:7-11` |

### Этап 1 — разблокировать параллелизм (M; главный этап)

| # | Задача | Заметки |
|---|---|---|
| 1.1 | **Per-profile сериализация ревизий** — минимальный вариант: выделенная очередь `research-tasks:revision` (types `revision.build`, `revision.consolidate`) со своим воркером concurrency=1. Все остальные типы — параллелятся | Мгновенный unlock: глобальный concurrency можно поднимать, ревизии остаются безопасными. Actor-семантику per-profile добить позже (см. 1.5) |
| 1.2 | **Классы очередей**: `fast` (`backtest.completed`, `backtest.resume`, `paper.start`, `paper.monitor`, `strategy.onboard`) / `heavy` (`research.run_cycle`, `hypothesis.build`, `strategy.baseline`, `strategy.wfo`) / `revision` (из 1.1), каждая со своим Worker и concurrency | BullMQ OSS: несколько Queue+Worker — штатно. `WorkflowRouter` не меняется, меняется только маршрутизация enqueue → имя очереди по taskType |
| 1.3 | **Callback-first сабмит — только для hypothesis.build-lane**: сократить `PLATFORM_RUN_MAX_POLLS` для этой lane и опираться на webhook-resume. Для experiment-lanes (WFO/baseline/holdout) resume НЕ работает (§4.3: strategy-таблица не ищется callback'ом; `taskId=exp_…` → `task_not_found`; эксперименты не ждут pending) — там сокращать poll **нельзя**, это умножит INCONCLUSIVE и потерянные точки сетки. Нужен либо отдельный (длиннее) poll-конфиг для experiment-lanes, либо 1.3b | Poll-конфиг сейчас общий (`services.platformPoll`) — разделить per-lane |
| 1.3b | (опционально, M) Сделать experiment-lanes возобновляемыми: callback-lookup по обеим таблицам ранов, `pending`-эксперимент → статус `suspended` + re-entry task вместо мгновенного INCONCLUSIVE, поздний результат точки сетки re-integrate | Это и фикс сегодняшнего риска: медленный бэктест (>60с) уже даёт ложный INCONCLUSIVE |
| 1.4 | **Семафор на сабмиты в backtester**: общий (Redis-счётчик или BullMQ limiter на очереди сабмитов) max-in-flight вокруг `submitOverlayRun`, вместо ручного правила произведения в комментарии. **Значение лимита = 4** (решение 2026-07-11, см. §6.2 — бенч осознанно отложен). Лимит обязательно вынести в env-переменную, чтобы будущая калибровка была правкой конфига, а не кода. ⚠️ Сам бенч исполнителю этого отчёта НЕ запускать | Реализация семафора — в lab, немедленно; калибровка — отложена (см. §6.2) |
| 1.5 | Правильная починка revision race (вместо/поверх 1.1): loser не дропает батч, а **перечитывает head и перекомпоновывает** (retry-on-conflict), либо pg advisory xact lock на hash(strategyProfileId) вокруг read-head→insert | Возвращает семантику «победители каждого цикла мержатся», а не «один racer на профиль» |
| 1.6 | Убрать critic-await из dispatch-петли `run_cycle`: параллелить ревью (`mapWithConcurrency`) или вынести в отдельный task-type | Сокращает время самого длинного хендлера |

После Этапа 1 разумные дефолты: `fast` concurrency 8-16, `heavy` 2-4 (под семафор 1.4),
`revision` 1.

### Этап 2 — горизонтальный масштаб (M/L, по мере надобности)

| # | Задача | Заметки |
|---|---|---|
| 2.1 | Реплики worker-сервиса (после 1.1/1.4): BullMQ распределяет сам; на одном хосте — общий volume `.artifacts` | Уже механически возможно |
| 2.2 | S3/MinIO-адаптер `ArtifactStorePort` + GC по refcount | Блокер мультихоста; порт готов |
| 2.3 | LLM-лимитер: token-bucket/семафор per-provider в `model-provider.ts` seam + явный `maxRetries`/backoff | Единственное место — все адаптеры уже ходят через него (148 импортов) |
| 2.4 | Ingress: body-limit + timeouts (Hono middleware); read-API либо остаётся single-instance (задокументировано), либо проекция переезжает в отдельный сервис | Chat sync-interpret можно оставить (UX), но с timeout |
| 2.5 | Retention-job'ы: `agent_event` (партиционирование по created_at или простой DELETE старше N), `action_proposal`, `research_task` архив | При текущем масштабе — low priority, при росте — обязательны |
| 2.6 | PgBouncer — только когда процессов станет >5-10 | Не раньше |

### Этап 3 — если B2C станет реальностью (L, отдельное проектирование)

- `tenant_id` на `research_task` / `strategy_profile` / `chat_session` + квоты
  (max concurrent tasks per tenant — чек в intake, у которого уже есть единый chokepoint
  `createAndEnqueueTask`).
- Fair scheduling: round-robin по тенантам поверх очередей Этапа 1 (BullMQ Pro groups или
  собственный диспетчер); токен-бюджет расширить с correlationId до tenant-агрегата —
  таблица `research_token_usage` уже готова как основа биллинга.
- Redis HA (`parseRedisUrl` → поддержка TLS/sentinel) и rate-limit на callback/chat ingress.
- Это отдельный проект; тащить tenant_id в схему «на всякий случай» сейчас не стоит —
  противоречит духу «no shortcuts», пока нет продуктового решения.

### Чего НЕ делать

- **Не поднимать `LAB_QUEUE_CONCURRENCY` до Этапа 1.1** — тихая потеря ревизионных батчей.
- **Не внедрять Redlock/OCC-фреймворки** — unique-констрейнты Postgres уже дают
  кросс-процессную корректность; не хватает retry-семантики, а не локов.
- **Не мигрировать оркестрацию на Mastra Workflows** — Saga через BullMQ + webhook-resume
  адекватна задаче (тут Perplexity прав).
- **Не ставить PgBouncer сейчас** — два процесса, ≤ ~20 соединений.
- **Не дробить lab на микросервисы** — ingress/worker-раскол уже даёт нужную ось
  масштабирования.

---

## 6. Открытые вопросы

1. ~~Покрывает ли webhook-resume lanes ExperimentService?~~ **Закрыт (2026-07-11): нет,
   только hypothesis.build-lane** — детали и следствия в §4.3, рекомендации 1.3/1.3b.
2. **Ёмкость бэктестера — калибровка отложена (решение 2026-07-11).** Семафор 1.4
   зафиксирован на **4** без бенча. Причина: единственный VPS бэктестера
   (`openclaw`, 89.124.86.84) — 4 ядра / 7.8 GB, на нём же 24/7 крутится live-стек
   торговой платформы (paper-host, intake, market, historical — подтверждено по
   `docker ps`, load avg ~2.0). Sandbox-бенч со свипом до 8 in-flight загнал бы load в
   8–12 и голодал live paper/market по CPU — недопустимо, пока идут циклы. И бесполезно:
   на 4-ядерном боксе с одним worker-процессом (`WORKER_CONCURRENCY=2`) бенч лишь
   переподтвердил бы ~4 = уже стоящий дефолт. Реальный выигрыш (лимит >4) достижим только
   на масштабированном multi-pod деплое бэктестера, которого пока нет.
   **Когда вернуться**: (а) появится окно без активной торговли (или отдельный бокс под
   бэктестер), либо (б) бэктестер получит горизонтальный деплой — тогда цифра >4 станет
   осмысленной. До тех пор 4 — settled value, не заглушка.
   Как замерить, когда дойдёт (инструменты уже есть в репо backtester): готовый бенч
   `apps/backtester/scripts/bench-workers.mts` (`BENCH_MODE=sandbox` = прод-путь с реальными
   Docker-ранами, `BENCH_N`/`BENCH_CONC` — sweep); формулы бюджета — `docs/OPERATIONS.md`
   («peak sandbox CPU/mem ≈ pods × WORKER_CONCURRENCY × avg_symbols_per_run × sandbox limits»);
   прошлый замер в `docs/ROADMAP.md`: один процесс с `WORKER_CONCURRENCY=4` даёт лишь ~1.51×
   (один JS-поток; масштабируют процессы, не in-process слоты), throughput ≈
   `processes × WORKER_CONCURRENCY / ~23с на ран`. Мерить на целевом окружении (VPS, не
   WSL2-demo — там sandbox-режим не заведётся из-за nested-Docker и цифры нерепрезентативны).
   Число для семафора = «колено» p95: максимальный in-flight, при котором p95 длительности
   рана деградирует ≤ ~25% против одиночного (важно и для poll-дедлайна 60с experiment-lanes,
   см. §4.3). После этапа 1 — повторить как e2e-валидацию уже через lab.
   **Замер НЕ блокирует этапы 0–1**: семафор 1.4 вводится со стартовым лимитом 4
   (сегодняшний контракт), бенч потом лишь поднимает лимит. Это отдельная задача
   (по SSH на VPS), не шаг исполнителя этого отчёта.
   **Handoff-контракт**: задача-бенч записывает результаты в
   `docs/research/2026-07-11-backtester-capacity-bench.md` (таблица p50/p95/runs-min по
   ступеням in-flight + рекомендованный лимит = «колено» p95); исполнитель 1.4 берёт
   лимит из этого файла, если он существует, иначе — дефолт 4.
3. Нужна ли пер-hypothesis param-sweep lane (seam есть — `paramGrid` в payload +
   `ParamGridRunner`). **Рекомендация (2026-07-11): best-of-grid по гипотезам не делать.**
   Гипотеза = валидация экономического механизма в одной точке; подбор параметров уже
   отделён в WFO-lane со строгим OOS — это разделение правильное, sweep его разрушает
   (multiple testing без поправок; усиливает известный failure mode «гейминга метрики»
   из первого live-прогона Цикла 1). Легитимный вариант — **robustness-чек победителей**
   (когда-нибудь после закрытия M1/W1 из hypothesis-eval review и нескольких полных
   циклов): детерминированная сетка ±10–20% по 1–2 ключевым параметрам (4–8 соседей),
   только для гипотез, уже прошедших гейт; критерий — отбраковка хрупких (медиана дельты
   по соседям > 0, ни одного катастрофического соседа; точка НЕ переизбирается) → reject
   `fragile_neighborhood`. Инфраструктура готова, решение методологическое.

## Приложение: ключевые файлы

- Очередь: `src/adapters/queue/bullmq-queue.adapter.ts`, `src/composition.ts:338`
- Intake/дедуп: `src/orchestrator/task-intake.ts:31-66`
- Worker: `src/worker/worker.ts:13-59`
- Ревизии: `src/orchestrator/handlers/revision-build.handler.ts:157,248-266`,
  `revision-consolidate.handler.ts:58`
- Бэктест-сабмит/poll/resume: `src/orchestrator/handlers/run-platform-backtest.ts:35-113`,
  `resume-platform-backtest.ts`, `src/research/run-backtest.ts:18-53`,
  `src/ingress/handle-backtest-callback.ts:20-48`
- Сетка: `src/research/param-grid-runner.ts`, `src/research/map-with-concurrency.ts`
- Бюджет: `src/orchestrator/token-budget.ts`,
  `src/adapters/repository/drizzle-token-usage.repository.ts:13-24`
- LLM: `src/adapters/llm/model-provider.ts:41-56`, `src/mastra/compose-mastra.ts`
- БД: `src/db/client.ts:7-11`, `src/db/schema.ts` (unique-констрейнты)
- Артефакты: `src/adapters/artifact/local-file-artifact-store.adapter.ts`
- Read API: `src/read-api/README.md:28`, `src/adapters/read/pg-notify-agent-event-stream.ts`
- HTTP: `src/ingress/server.ts`, `src/ingress/app.ts:28-74`, `src/chat/chat-app.ts:24-48`
