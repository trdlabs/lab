# trading-lab — Design Document

**Дата:** 2026-06-10
**Статус:** Approved (design only, без реализации)
**Тип:** Архитектурный дизайн-документ
**Язык:** русский (технические имена сущностей, типов, workflow, таблиц, интерфейсов — английские)

---

## 0. Контекст и решения брейншторминга

`trading-lab` — новая мультиагентская исследовательская система (TypeScript / Mastra) поверх существующей `trading-platform`. Цель — **research brain**: онбординг стратегий, генерация гипотез, сборка артефактов, бэктест через платформу, оценка, paper-валидация и research-память. Система **research-only** и **не имеет live-authority**.

### Зафиксированные решения

| # | Решение | Выбор |
|---|---|---|
| 1 | Расположение | **Отдельный репозиторий** + Docker. Свои доменные типы в lab, маппинг на контракты платформы — только в адаптере. |
| 2 | Очередь MVP | **BullMQ** за `TaskQueuePort` — как **MVP task/job queue, не permanent event backbone**. NATS JetStream — later option. |
| 3 | Builder | **LLM генерирует код целиком** (через RAG над Builder SDK 021). Безопасность держится на платформенном sandbox 019, не на lab-валидации. |
| 4 | Типы на границе | **Свои типы в lab + маппинг в адаптере** на контракты 017/021/022/023. |
| 5 | Suspend/resume | **Backtest = event-driven suspend/resume; paper = state-machine re-entry** через `paper_validation_run` + periodic `paper.monitor`. |
| 6 | Build Validator | **Fast-fail gate, не security boundary.** Artifact остаётся `candidate` до приёма платформой. |

### Грунтинг по реальному состоянию `trading-platform`

Реальный список спеков платформы — `001`–`027`. Несколько «будущих» контрактов уже существуют как спеки и используются как точки маппинга:

- **017 — strategy-hypothesis-contract** (code-first TS): `StrategyModule` / `HypothesisOverlayModule`, замкнутые union'ы `StrategyDecision` / `OverlayDecision`, read-only point-in-time `StrategyContext`, runner-owned `RiskProfile` / `ExecutionProfile`, `BacktestRunRequest` / `BacktestRunResult`, `ValidationResult`, `ModuleManifest`, lifecycle `research_only → reviewed → promoted` (forward-only). **Гипотеза = overlay-модуль.**
- **018 — research-backtest-runner**: event-driven runner, прогон **baseline vs variant**, `ComparisonSummary` с дельтами метрик, `ModuleExecutor` / `InProcessTrustedModuleExecutor`.
- **019 — sandbox-module-gateway**: `ModuleBundle` (ESM payload + `manifest.json` + `bundle.json` + content-hash `bundleHash`), `validateBundle` acceptance-gate. **Runtime-изоляция — авторитетная граница безопасности; статический скан импортов неавторитетен.**
- **020 — indicator-engine**: platform-owned indicator engine, `ctx.indicators`.
- **021 — builder-sdk**: Module Authoring Kit — шаблоны, decision/manifest/bundle-helpers, локальная валидация, LLM-friendly документация для производства валидного `ModuleBundle`.
- **022 — research-artifact-contract**: `ResearchRunEnvelope` с `runStatus: completed | rejected`, content-addressable `reference = sha256:<hex>` от canonical JSON, `ArtifactDescriptor`, `ArtifactValidationResult`, `EvidenceBundle` (гидратационное представление).
- **023 — market-tape-contract**: универсальная историческая market tape / dataset contract.

Платформенной **MCP-фичи (роадмапный «030») пока нет** → MVP `trading-lab` работает на Mock/Fixture-адаптерах.

> ⚠️ Роадмап из исходного контекст-документа (023–033) частично дрейфует от реальности. Источник истины по контрактам — спеки в `trading-platform/specs/`, а не нумерация роадмапа.

---

## 1. Границы системы (System boundaries)

### `trading-platform` владеет (execution authority)

market data, datasets, historical tape (023), market context/regime (если есть), backtest runner (018), sandbox execution (019), indicator engine (020), Builder SDK (021), research artifact contract (022), paper/live runtime, simulated orders/fills/trades, decision logs, strategy module execution, risk/execution authority, golden master / parity harness, полные backtest-артефакты. **Не зависит от `trading-lab`.**

### `trading-lab` владеет (research brain)

research tasks, strategy profiles, hypothesis proposals, agent outputs, semantic dedupe гипотез, research memory, evaluation decisions, experiment metadata, нормализованные копии результатов, artifact references, LLM-аудит, orchestration state, multi-agent workflow logic.

### Структурная гарантия research-only

У `trading-lab` **нет execution-адаптера**, способного разместить ордер. `PlatformGatewayPort` экспонирует только research/backtest/paper-методы; всё, что попадает на платформу, идёт в sandbox/paper runtime, **никогда в live**. Это структурная, а не «договорная» гарантия.

```
trading-lab     = research brain, hypothesis memory, multi-agent workflows
trading-platform = market data, runner, sandbox, paper/live runtime, execution authority
```

---

## 2. Высокоуровневая архитектура

- **Workflow-governed:** агенты рассуждают, workflow решает.
- **Schema-driven:** все LLM-выходы — schema-validated JSON (Zod).
- **Deterministic around side effects:** Orchestrator владеет всеми side-effects (DB writes, platform submit, enqueue).
- **Agentic только там, где нужно open-ended reasoning.**
- **Fully auditable, safe by default.**

LLM **не владеет**: routing, retries, queue ack/fail, platform submission, paper/live-решениями.

---

## 3. Архитектурная диаграмма

```
┌──────────────────────────────────────────────────────────────────────┐
│ External sources                                                       │
│  Telegram │ Web chat │ Crawler │ Cron/Scheduler │ Platform callback │  │
│           │          │         │                │  Operator         │  │
└─────┬──────────────────────────────────────────────────────────────┬──┘
      │ HTTP                                                          │
      ▼                                                               │
┌───────────────┐    persist (canonical)     ┌──────────────────────┐│
│  Ingress API  │ ─────────────────────────▶ │ Postgres             ││
│ (не агент,    │   research_task /          │  research_task       ││
│  не рассуждает)│   agent_event              │  agent_event ...     ││
└──────┬────────┘                            └──────────────────────┘│
       │ enqueue {taskId, taskType,                                   │
       │          correlationId, dedupeKey}                           │
       ▼                                                              │
┌──────────────────┐   transport only (НЕ канон)                      │
│  TaskQueuePort   │ ───▶  BullMQ (Redis)   [later: NATS JetStream]   │
└──────┬───────────┘                                                  │
       │ consume                                                      │
       ▼                                                              │
┌─────────────────────────────────────────────────────────────────┐  │
│ Orchestrator (deterministic TS)                                 │  │
│   Queue Consumer → Workflow Router (taskType → workflow)        │  │
│        ↓ runs                                                    │  │
│   Mastra Workflows                                              │  │
│     ├─ nodes → Agents (LLM, возвращают только JSON)             │  │
│     ├─ nodes → Validators (deterministic gates)                │  │
│     └─ side effects → ВЛАДЕЕТ Orchestrator:                     │  │
│            DB writes │ PlatformGateway calls │ enqueue          │  │
│   State persistence: Mastra storage (схема mastra_*) в Postgres │  │
└──────┬──────────────────────────────────────────────────────────┘  │
       │ via ports                                                    │
       ▼                                                              │
┌─────────────────────────────────────────────────────────────────┐  │
│ PlatformGatewayPort                                             │  │
│   Fixture │ Mock │ Http │ Mcp  (адаптеры)                       │  │
└──────┬──────────────────────────────────────────────────────────┘  │
       │                                                              │
       ▼                                                              │
┌─────────────────────────────────────────────────────────────────┐  │
│ trading-platform: runner 018 │ sandbox 019 │ artifacts 022 │    │  │
│ paper runtime │ risk/execution authority                       │──┘
│         backtest.completed / paper events ─────────────────────────▶ Ingress (resume)
└─────────────────────────────────────────────────────────────────┘
```

Принцип цепочки: **агенты рассуждают → workflow решает → Orchestrator владеет side-effects → платформа исполняет.**

---

## 4. Ingress API

Тонкий HTTP-слой. **Не агент, не рассуждает.**

**Ответственности:**

1. Принять/аутентифицировать внешний запрос или событие.
2. Валидировать payload.
3. Нормализовать во внутренний task/event-формат.
4. Создать canonical `research_task` / `agent_event` в Postgres.
5. Enqueue только `taskId` / маленький envelope в очередь.
6. Вернуть `accepted` / `rejected`.
7. Обрабатывать секреты/аутентификацию внешних callback'ов.
8. **Дедуплицировать idempotent-события** по `dedupeKey`.
9. **Точка входа resume-callback'ов** платформы (`backtest.completed`, paper events) → Orchestrator находит suspended workflow по `correlationId` / `platformRunId`.

---

## 5. Очередь / EventBus

- `TaskQueuePort` — абстракция. Первый адаптер — **BullMQ**.
- **BullMQ выбран как MVP task/job queue, а не как permanent event backbone.** Он покрывает delayed jobs, retries, rate-limit, dedupe по `jobId`, scheduler для cron-wake — этого достаточно для MVP. Для долгосрочной multi-worker event-driven архитектуры с высоким fan-out остаётся **NATS JetStream как later option**.
- Redis/очередь — **транспорт, не канонический стор.**

**Envelope (только это в очереди):**

```ts
type QueueEnvelope = {
  taskId: string;
  taskType: AgentTaskType;
  correlationId: string;
  source: 'telegram' | 'web' | 'crawler' | 'cron' | 'platform' | 'operator';
  attempt: number;
  dedupeKey?: string;
};
```

Полные payload'ы, LLM-выходы, strategy profiles, hypotheses, результаты, артефакты, решения — в Postgres / artifact storage.

### Task types

```ts
type AgentTaskType =
  | 'strategy.onboard'
  | 'strategy.analyze_source'
  | 'research.generate_hypotheses'
  | 'research.run_cycle'
  | 'hypothesis.build'
  | 'backtest.submit'
  | 'backtest.completed'
  | 'sweep.run'
  | 'paper.start'
  | 'paper.monitor'
  | 'performance.review'
  | 'research.pause'
  | 'research.wake_check';
```

---

## 6. Mastra Orchestrator / Workflow Router

«Orchestrator» — **не один LLM-агент**, а доменный orchestration-слой из детерминированного TS:

- Queue Consumer
- Workflow Router (`Record<AgentTaskType, Workflow>`)
- Mastra workflows
- deterministic services
- specialized agents внутри workflows
- state persistence

Mastra предоставляет: agents, workflows, tools, typed inputs/outputs, suspend/resume, memory/retrieval, observability, MCP-client (later). Но **routing/retry/ack/submit/paper-решения — детерминированный код, не LLM.**

### Suspend/resume — две механики

**A. Event-driven suspend/resume (короткие/средние ожидания, backtest):**

1. Workflow доходит до submit → Orchestrator вызывает `submitBacktest`, persist `BacktestRunRef`.
2. Workflow **suspends**; снапшот состояния — в Mastra storage (схема `mastra_*` в Postgres).
3. Платформа завершает backtest → шлёт `backtest.completed` callback → Ingress → Orchestrator находит suspended workflow по `correlationId` / `platformRunId`.
4. **Resume** с результатом → normalize → Evaluator → persist.

**B. State-machine re-entry (длинные ожидания, paper за дни/недели):**

1. **Не держим живой suspended workflow неделями.**
2. Пишем `paper_validation_run` строку (канон) + ставим cron-таск `paper.monitor`.
3. Каждый `paper.monitor` — короткий workflow: читает текущий статус, проверяет условия выхода (N trades / max duration / max DD / operator stop), при достижении — оценивает и решает.
4. Между проверками никакого живого процесса нет — состояние в БД.

**Персистентность состояния:** Mastra storage — **операционное** состояние (снапшоты workflow), в отдельной схеме `mastra_*`. **Канон** research-состояния — в `lab_*` таблицах. Mastra memory — derived/supplementary, не источник истины.

---

## 7. Роли агентов

Мультиагентность с самого начала, но каждый агент — **узкая роль**. Агенты возвращают **только JSON**; решают workflow/детерминированные gates.

| Агент | Тип | Вход → Выход | Назначение |
|---|---|---|---|
| **Strategy Analyst** | LLM | source (код/README/NotebookLM/article/manual/crawler) → `StrategyProfile` JSON + confidence + unknowns + evidence | Структурное понимание стратегии до генерации гипотез. |
| **Researcher** | LLM | profile + trades + decision logs + market context + прошлые бэктесты + similar hypotheses + regime → `HypothesisProposal[]` | Falsifiable гипотезы. **Не генерирует код** — гипотеза это контракт между Researcher и Builder. |
| **Critic / Risk Reviewer** | LLM (опц., за `ENABLE_CRITIC_AGENT`, default `false`) | hypothesis → review | Falsifiable? overfit? lookahead? data-availability? sample size? дубликат прошлого fail? нарушение boundaries? измеримость эффекта? **Не gate** — обязательный gate всегда deterministic Validator. |
| **Validator** | **детерминированный (не LLM)** | proposal → pass/fail + reasons | Schema, required fields, allowed features/actions, parameter ranges, no exact-dup, no unavailable features, no authority violation, no live intent, no lookahead markers. **Бежит до Builder.** |
| **Builder** | LLM (полная кодогенерация) | valid `HypothesisProposal` → `ModuleBundle` candidate | Через RAG над Builder SDK 021. **Не submit'ит на платформу, не исполняет код в lab.** Выход — build-artifact candidate с manifest/hash. |
| **Build Validator** | **детерминированный (не LLM)** | bundle → pass/fail | Syntax, TS-compile, SDK-contract conformance (017/021), restricted imports, manifest/bundle layout, `bundleHash`, capability constraints. **Fast-fail gate, НЕ security boundary** (см. §12). |
| **Evaluator** | **детерминированный (не LLM)** | `ComparisonSummary` (018) → решение | `PASS` / `MODIFY` / `FAIL` / `INCONCLUSIVE` / `PAPER_CANDIDATE`. LLM может дать комментарий, но gate — код. |
| **Performance Monitor** | детерминированный (+опц. LLM summary) | bot perf / regime → trigger/keep-paused | Деградация, смена режима, рост DD, накоплены новые trades, время с последнего цикла, cooldown по fail-streak. |
| **Knowledge Curator** | LLM (later) | завершённый цикл → durable memory | Что тестировали, что failed/worked, какие режимы/фичи важны, что не повторять. |

**Evaluator инспектирует:** net PnL, drawdown, win rate, total trades, profit factor, expectancy, fragility, top-trade contribution, robustness, out-of-sample/walk-forward (later), сравнение с baseline, sample size.

---

## 8. Workflows

Не один гигантский workflow — несколько узких.

### 8.1 Strategy Onboarding Workflow

```
strategy source
  → Strategy Analyst Agent
  → StrategyProfile validation (Validator)
  → dedupe по sourceFingerprint
  → persist StrategyProfile
  → create embeddings
  → опц. Critic review
```
Выход: `StrategyProfile`, source artifacts, embeddings, audit trace.

### 8.2 Research Cycle Workflow

```
load StrategyProfile
  → load trades / decision logs / market context через PlatformGateway
  → search_similar_hypotheses (pgvector, в lab)
  → Researcher Agent → HypothesisProposal[]
  → Critic Agent (опц.)
  → deterministic validation (Validator)
  → persist accepted / rejected (с reasons)
```
Выход: accepted `HypothesisProposal`, rejected с причинами, research summary.

### 8.3 Build & Backtest Workflow

```
load valid HypothesisProposal
  → Builder Agent → ModuleBundle candidate
  → Build Validator (fast-fail)
  → Orchestrator сохраняет artifact (artifact_ref)
  → Orchestrator submits BacktestRunRequest (baseline=StrategyModule, variant=HypothesisOverlayModule)
  → persist BacktestRunRef
  → SUSPEND
  → resume на backtest.completed
  → normalize ComparisonSummary (018) / ResearchRunEnvelope (022)
  → Evaluator → EvaluationDecision
  → persist
```
**Builder не submit'ит. Orchestrator владеет side-effects.**

### 8.4 Parameter Sweep Workflow (later)

```
valid hypothesis
  → generate parameter grid
  → create ExperimentRun
  → create many BacktestRun records
  → submit runs (с учётом max concurrent)
  → collect results
  → aggregate → robustness/sensitivity
  → Evaluator
```

### 8.5 Paper Validation Workflow (отдельный, state-machine re-entry)

```
candidate (PAPER_CANDIDATE)
  → create PaperValidationTask + paper_validation_run (канон)
  → Orchestrator просит платформу стартовать paper bot
  → re-entry через cron paper.monitor до:
       N trades collected │ max duration │ max drawdown │ operator stop
  → evaluate paper results
  → promote / reject / extend / modify
```
**Не держим research-workflow живым неделями.**

### 8.6 Performance Review / Wake Workflow

```
cron или platform event
  → get current bot performance
  → get market regime
  → compare с last research state
  → если degraded или regime changed: enqueue research.run_cycle
    иначе: keep paused
```

---

## 9. Adaptive pause / wake policy

Детерминированный **Research Policy / Budget Governor**.

```ts
type ResearchPolicyState = {
  strategyId: string;
  consecutiveFailedCycles: number;
  lastSuccessfulHypothesisAt?: string;
  pausedUntil?: string;
  pauseReason?: string;
  lastKnownRegime?: string;
  lastKnownPerformance?: {
    netPnl: number; sharpe?: number; maxDrawdown?: number; tradeCount: number;
  };
};
```

**Политика:** после 3 failed-циклов без улучшающей гипотезы — пауза для стратегии. Wake при: ухудшении live/paper, смене режима, появлении новых market features, накоплении новых trades, истечении cooldown, ручном запросе оператора.

**Budget guardrails:** max LLM calls per cycle, max hypotheses per cycle, max backtests per hypothesis, max concurrent backtests, max sweep combinations, max daily spend, stop на повторных validation-failures.

---

## 10. Доменная модель и минимальные схемы v1

### StrategyProfile v1 (минимум)

```
strategy_id, version, source_kind, source_fingerprint,
direction, core_idea, required_market_features[],
confidence, unknowns[], schema (JSONB), embedding,
contract_version            // версия lab-схемы StrategyProfile
```
Vector-поиск находит похожие стратегии; JSONB/колонки — канон.

### HypothesisProposal v1 (минимум)

```
hypothesis_id, strategy_profile_id, thesis, target_behavior,
rule_action (JSONB), required_features[], validation_plan,
expected_effect, invalidation_criteria, confidence, status,
embedding, contract_version  // версия lab-схемы HypothesisProposal
```
Семантически = заготовка под `HypothesisOverlayModule` (017). `search_similar_hypotheses` живёт **в lab**, не на платформе.

### ExperimentRun

Общая абстракция для: single backtest / parameter sweep / robustness grid / walk-forward / out-of-sample / parity check / paper validation setup. **Не моделировать всё как только `sweep_runs`.**

---

## 11. Storage model

- **Postgres** — канон research-метаданных.
- **pgvector** — retrieval, **не источник истины**.
- **Redis** — task delivery, **не durable storage**.
- Тяжёлые артефакты (equity curve, decision trace, full logs) — `artifact_ref` (content-addressable `sha256:<hex>`, как 022), **не JSONB-блобы**.
- Mastra storage — отдельная схема `mastra_*` (операционное состояние).
- Хранение payload'ов артефактов — за **`ArtifactStorePort`** (см. ниже), чтобы менять backend без изменения доменной модели.

### ArtifactStorePort

```ts
interface ArtifactStorePort {
  put(content: Buffer | string, meta: { kind: string; mime_type: string; producer: string; metadata?: Record<string, unknown> }): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Buffer>;
  resolveUri(ref: ArtifactRef): string;
}
```

| Адаптер | Назначение | Когда |
|---|---|---|
| **LocalFileArtifactStore** | `file://`-рефы на локальной ФС | MVP (SP-1…SP-4) |
| **S3ArtifactStore** | S3-совместимое хранилище | SP-5 или при реальной необходимости |

`put()` сам считает `content_hash = sha256:<hex>` от canonical-контента (content-addressable, идемпотентно). Доменная модель работает только с `ArtifactRef`, не зная о backend.

### Core tables / entities

```
research_task            agent_event              strategy_source_artifact
strategy_profile         strategy_profile_version hypothesis_proposal
hypothesis_review        hypothesis_build         experiment_run
parameter_sweep          backtest_run             backtest_trade
evaluation_decision      paper_validation_run     research_policy_state
artifact_ref             agent_run                llm_audit_event
```

### artifact_ref (минимальная форма)

```ts
type ArtifactRef = {
  artifact_id: string;       // PK
  uri: string;               // где лежит payload (s3://, file://, platform-ref)
  content_hash: string;      // sha256:<hex> от canonical JSON (схема 022)
  kind: string;              // 'equity_curve' | 'decision_trace' | 'logs' | 'module_bundle' | ...
  size_bytes: number;
  mime_type: string;         // 'application/json' | 'application/octet-stream' | ...
  created_at: string;        // ISO timestamp
  producer: string;          // 'builder' | 'platform' | 'evaluator' | ...
  metadata: Record<string, unknown>; // JSONB: свободные доп. поля
};
```

### BacktestRun (нормализованные метрики — реальные колонки)

```
experiment_run_id, platform_run_id, hypothesis_id, strategy_profile_id,
params (JSONB), params_hash,               // params_hash — идемпотентность
status, started_at, finished_at,
total_trades, net_pnl_usd, net_pnl_pct, win_rate, profit_factor,
sharpe, sortino, max_drawdown_pct, avg_win_usd, avg_loss_usd, expectancy_usd,
top_trade_contribution_pct, top_3_trades_contribution_pct,
delta_without_top_1_usd, delta_without_top_3_usd, is_fragile,
artifact_refs[],
platform_contract_version, sdk_contract_version  // защита от drift 017/018/021/022
```

### BacktestTrade (отдельные строки, не JSONB-массив)

```
backtest_run_id, symbol, side, entry_ts, exit_ts, entry_price, exit_price,
qty, notional_usd, pnl_usd, pnl_pct, fees_usd, mae_pct, mfe_pct,
exit_reason, dca_count, holding_minutes, metadata (JSONB)
```
**Без партиционирования в MVP.** Позже — по реальным query-паттернам (hash по `backtest_run_id` / range по `entry_ts` / range по experiment date). **Без TimescaleDB в MVP.**

### Equity curve / decision traces

Summary-метрики — в Postgres; equity curve / decision trace / full logs — `artifact_ref`. Детальные equity-точки в Postgres/Timescale — только later для promoted-прогонов, если time-series анализ станет центральным.

---

## 12. Validation & safety gates

### Конвейер gates (по порядку)

```
1. Schema gate (Zod)            — все LLM-выходы schema-validated
2. Domain validation gate       — Validator (§7): features/ranges/dup/authority/lookahead
3. Build validation gate        — Build Validator: 021 local-validation + bundleHash + contract conformance
                                  ⚠ FAST-FAIL, НЕ security boundary
4. Submission contract gate     — обязательны: taskId, correlationId, hypothesisId,
                                  artifactHash, validationResult, platformRunId
5. Deterministic Evaluation gate — Evaluator: PASS/MODIFY/FAIL/INCONCLUSIVE/PAPER_CANDIDATE
```

### Принципиально про Build Validator

Build Validator в `trading-lab` — **fast-fail gate, а не граница безопасности**. `trading-lab` **не исполняет** generated code. Авторитетная граница безопасности — **платформенный sandbox 019** (как 019 явно фиксирует: статический скан импортов неавторитетен, авторитетна runtime-изоляция). Builder artifact остаётся **`candidate`** до приёма платформой.

### Hard constraints

1. `trading-lab` — research-only.
2. Нет live order placement из агентов.
3. Нет live execution authority.
4. Нет risk authority.
5. Нет прямых platform side-effects из Builder/Researcher.
6. Orchestrator владеет side-effects.
7. Платформа владеет sandbox execution.
8. Платформа владеет paper/live runtime.
9. LLM-выходы schema-validated.
10. Evaluation gates детерминированы.
11. Каждый platform submission несёт `taskId`, `correlationId`, `hypothesisId`, artifact hash, validation result, `platformRunId`.
12. Нет arbitrary code execution в `trading-lab`.
13. Generated code проходит через sandbox/платформу.
14. Нет огромных JSONB-блобов для больших результатов.
15. Нет дублирующих backtest для одного experiment + `params_hash`.
16. Нет бесконечных циклов: max iterations per workflow.
17. Cost budgets enforced.

### Защита от drift контрактов (`*_contract_version`)

Каждая ключевая сущность и envelope несут версии контрактов, чтобы пережить дрейф 017/021/022:

- `contract_version` — версия **lab-схемы** сущности (`StrategyProfile`, `HypothesisProposal`, и т.д.).
- `sdk_contract_version` — версия **Builder SDK (021)**, под которую собран `ModuleBundle`.
- `platform_contract_version` — версия **платформенного контракта (017/018/022)**, под которую сделан submit/получен envelope.

Несовместимость версий ловится на Submission contract gate и при ingest результата. `ResearchRunEnvelope` (022) уже несёт contract-version — lab сверяет его со своим ожиданием.

---

## 13. Observability & audit

**Langfuse / OTel-совместимый трейсинг.** Трейсим: каждый workflow run, agent call, LLM input/output metadata, token usage, model name, cost estimate, tool calls, validation failures, backtest submission, resume events, evaluation decisions.

**Канон-аудит в Postgres:** `agent_run`, `llm_audit_event`, task transitions, platform submission events.

Observability — для debug/cost-control, **не канонические бизнес-данные**.

---

## 14. Python ML service (later)

Основной orchestration-слой — TS/Mastra. ML не форсируем в TS:

```
trading-lab TS/Mastra
        ↓ HTTP или MCP
ml-pattern-service Python/FastAPI
        ↓
pandas / sklearn / lightgbm / torch
```
Возможные ML-инструменты: паттерны в losing trades, кластеризация режимов, feature importance, anomaly detection, parameter sensitivity, meta-labeling (later). Вызывается как MCP-сервер или HTTP-tool. **ML — сервис, не оркестратор.**

---

## 15. PlatformGateway — ports / adapters

```ts
interface PlatformGatewayPort {
  getBotTrades(...args: unknown[]): Promise<unknown>;
  getDecisionLogs(...args: unknown[]): Promise<unknown>;
  getMarketContext(symbol: string, tsOrWindow: unknown): Promise<MarketContext>;
  getMarketRegime(symbol: string, tsOrWindow: unknown): Promise<MarketRegime>;
  submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef>;     // маппинг → 017
  getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope>; // маппинг → 022
  startPaperValidation(...args: unknown[]): Promise<unknown>;
  getPaperStatus(...args: unknown[]): Promise<unknown>;
}
```

### Адаптеры (явное разведение)

| Адаптер | Назначение | Когда |
|---|---|---|
| **FixturePlatformGatewayAdapter** | Deterministic tests / golden examples — фиксированные входы→выходы | Тесты (Vitest), регрессии, golden master |
| **MockPlatformGatewayAdapter** | Local MVP/dev behavior — правдоподобные, но не платформенные ответы | Локальная разработка MVP (SP-1…SP-4) |
| **HttpPlatformGatewayAdapter** | Временный bridge, если REST появится **до** MCP | Переходный период |
| **McpPlatformGatewayAdapter** | Финальный адаптер после platform feature 030/031 (MCP) | Production-интеграция |

**MCP — адаптер, не доменная модель.** MCP-вызовы **не зашиваются** в агентов. Маппинг lab-типов ↔ контракты 017/018/022 живёт **только** в адаптерах.

### MarketContext / MarketRegime

**MarketContext** (raw/derived факты на исторический или текущий момент): OHLCV, OI, liquidations, funding, CVD, taker buy/sell, L/S ratio, volatility, spread, local trend, candle body/wick, liquidity features. **Обязательна поддержка исторического timestamp**, не только current: `get_market_context(symbol, ts/window)`.

**MarketRegime** (интерпретированный детерминированный/ML-режим): `capitulation`, `short_squeeze`, `trending`, `ranging`, `high_volatility`, `low_liquidity`, `post_dump_recovery`, `distribution`, `unknown`: `get_market_regime(symbol, ts/window)`. Researcher использует regime, чтобы условить гипотезы и не тестировать нерелевантные идеи.

---

## 16. RAG и память

- **RAG для Builder:** SDK-docs, module contracts (017/021), примеры, generated types, feature 017/019/021/026 specs, capability manifests → помогает генерировать валидный код.
- **RAG для Researcher:** similar hypotheses, прошлые fail/success, strategy profiles, research summaries, known pitfalls, regime-specific learnings.
- **Agent memory:** Mastra memory помогает в разговорах агентов, но **не канон**. Канон — в project-таблицах; memory/retrieval — derived/supplementary.
- **Postgres + pgvector первыми.** Без Qdrant/Pinecone в MVP.

---

## 17. Status lifecycles

### HypothesisProposal.status

```
draft
  → validated          (прошёл Validator §7)
  → rejected           (Validator/Critic отклонил; terminal)
  → accepted           (готов к build)
  → building           (взят Build & Backtest workflow)
  → backtested         (есть EvaluationDecision)
  → paper_candidate    (Evaluator: PAPER_CANDIDATE)
  → promoted           (paper прошёл; передан для review/promotion на платформе)
  → archived           (terminal: устарел / superseded / закрыт политикой)
```

### HypothesisBuild.status

```
pending
  → generating         (Builder работает)
  → build_failed       (Build Validator fast-fail; terminal для этой попытки)
  → candidate          (валидный ModuleBundle, ждёт submit; НЕ принят платформой)
  → submitted          (отправлен на backtest через PlatformGateway)
  → accepted_by_platform   (платформа приняла bundle — sandbox 019 ok)
  → rejected_by_platform   (платформа/sandbox отклонила; terminal)
```

### BacktestRun.status

```
queued
  → submitted          (BacktestRunRef получен)
  → running            (платформа исполняет)
  → completed          (ResearchRunEnvelope.runStatus = completed)
  → rejected           (ResearchRunEnvelope.runStatus = rejected; terminal)
  → failed             (инфраструктурная ошибка/timeout; terminal)
  → evaluated          (Evaluator вынес EvaluationDecision)
```

> Маппинг: `BacktestRun.status` синхронизируется с `ResearchRunEnvelope.runStatus` (`completed | rejected`) из 022; `completed` → дальше `evaluated`.

---

## 18. MVP-фазы

| Фаза | Содержание |
|---|---|
| **SP-1 Foundation** | TS skeleton; Mastra setup; Postgres schema draft; `TaskQueuePort`; **BullMQ** adapter; Ingress API minimal endpoint; domain types; **Mock + Fixture** PlatformGateway; `ArtifactStorePort` + **LocalFileArtifactStore**; basic Workflow Router; deterministic validators; Critic — только типы/интерфейс/место в workflow (без LLM); Vitest. |
| **SP-2 Strategy onboarding** | Strategy Analyst Agent; `StrategyProfile` schema; profile validator; source fingerprint; persistence; embeddings/dedupe (опц.). |
| **SP-3 Research cycle** | Researcher Agent; `HypothesisProposal` schema; **deterministic hypothesis Validator (обязательный gate)**; Critic Agent — за `ENABLE_CRITIC_AGENT=true` (default off); persistence; `search_similar_hypotheses` (pgvector или mock). |
| **SP-4 Build + mock backtest** | Builder Agent; SDK-docs RAG (placeholder/fixture); build-artifact model; Build Validator; **MockBacktestGateway**; Orchestrator-owned submit; Evaluator. |
| **SP-5 Platform integration** | **McpPlatformGatewayAdapter** когда готов platform 030/031; real `submitBacktest`; suspend/resume на platform callback; нормализованный ingest результата; при необходимости — **S3ArtifactStore**. |
| **SP-6 Paper + perf monitor** | paper workflow (state-machine re-entry); performance review workflow; research pause/wake policy; budget governor. |

**Fixtures-first** до появления платформенного MCP. MVP остаётся **архитектурно мультиагентским**, но без полной автономии сразу.

---

## 19. Trade-offs

1. **Отдельный repo → дублирование типов** до появления shared-пакета. Принятый компромисс ради чистой границы и независимого деплоя/CI. Маппинг изолирован в адаптерах.
2. **«LLM генерирует код целиком» → выше гибкость, но безопасность держится на платформенном sandbox 019**, не на lab-валидации. Требует жёсткого Submission contract gate и того, что lab **никогда** не исполняет артефакт. Build Validator — только fast-fail.
3. **BullMQ vместо NATS в MVP** — проще в Node, достаточно для delayed/retry/schedule. Цена: не permanent event backbone; миграция на NATS — отдельная later-работа за тем же `TaskQueuePort`.
4. **Две механики suspend/resume** — сложнее, чем одна, но избегает живых workflow на недели (paper). Цена: два кодпути (event-driven vs state-machine re-entry).
5. **Нормализованные метрики колонками + артефакты рефами** — больше схемы, но дешёвые запросы и нет JSONB-блобов.

---

## 20. Open questions

1. Точная форма платформенной MCP-фичи (роадмапный «030») ещё не написана → Mock/Fixture-first, финализация маппинга McpPlatformGatewayAdapter позже.
2. Где провести точную границу `MarketContext` features v1 vs позже (зависит от 023/027 платформы).
3. Формат shared-пакета контрактов, если/когда дублирование типов станет дорогим.

### Закрытые решения (ранее open)

- **Critic в MVP** → часть target-архитектуры, но **опционален и выключен по умолчанию** за `ENABLE_CRITIC_AGENT` (default `false`). В SP-1/SP-2 — только типы/интерфейс/место в workflow, без реального LLM. В SP-3 — допускается включение за флагом. Обязательный gate всегда — **deterministic Validator**.
- **Artifact storage в MVP** → **`LocalFileArtifactStore` + `file://`-рефы** через `ArtifactStorePort`. `S3ArtifactStore` — не раньше SP-5 / реальной необходимости. `artifact_ref` остаётся content-addressable (`content_hash = sha256:<hex>`).

---

## 21. Risks & simplifications

- **Risk: drift контрактов 017/021/022.** Митигация: маппинг только в адаптерах + `contract_version` / `sdk_contract_version` / `platform_contract_version` в сущностях и envelopes; сверка версий на gates.
- **Risk: небезопасный generated code.** Митигация: lab не исполняет код; авторитетная граница — sandbox 019; artifact = `candidate` до приёма платформой.
- **Risk: дубли гипотез/бэктестов.** Митигация: `sourceFingerprint` (стратегии), embedding + exact-hash (гипотезы), `params_hash` (бэктесты).
- **Risk: бесконечный research/перерасход.** Митигация: Research Policy / Budget Governor, max iterations, cooldown по fail-streak.
- **Risk: Redis как «случайный» канон.** Митигация: только envelope в очереди; канон в Postgres; артефакты — рефами.
- **Simplification (MVP):** без партиционирования, без TimescaleDB, без Qdrant/Pinecone, без Python ML, Critic опционален, MCP-адаптер — позже. Никакой speculative-инфраструктуры без обоснования.

---

## 22. Принципы дизайна (резюме)

- Start multi-agent, but bounded.
- Deterministic workflow control > LLM supervisor control.
- Агенты рассуждают; workflows решают.
- Агенты производят JSON; validators одобряют.
- Orchestrator владеет side-effects.
- Платформа владеет execution.
- Postgres владеет каноном.
- pgvector — retrieval, не истина.
- Redis — транспорт, не истина.
- MCP — адаптер, не домен.
- Python ML — сервис, не оркестратор.
- MVP маленький, но architecture-compatible с финальным видением.
- Никакой speculative-инфраструктуры без обоснования.

---

*Конец дизайн-документа. Реализация — после одобрения и перехода к implementation plan (writing-plans).*
