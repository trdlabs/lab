# trading-lab SP-2 — Strategy Onboarding Design

**Дата:** 2026-06-11
**Статус:** Approved (design only)
**Фаза:** SP-2 (Strategy onboarding) поверх SP-1 Foundation (merged в `main`)
**Ветка:** `sp2-strategy-onboarding` от `main`
**Язык:** русский; технические имена сущностей/типов/таблиц — английские

---

## 0. Цель и решения

**Цель SP-2:** превратить *источник стратегии* (bot code / README / article / NotebookLM summary / manual description / crawler) в валидированный, персистентный, дедуплицированный `StrategyProfile`. Это первый реальный LLM-агент в системе; Mastra входит **только как `Agent`-примитив**.

### Зафиксированные решения

| # | Решение | Выбор |
|---|---|---|
| 1 | Mastra footprint | **Только `Agent`-примитив** (`@mastra/core/agent`), вызывается из `strategy.onboard` handler. Без Mastra server/workflows. Оркестрация остаётся на `WorkflowRouter` (design §6). |
| 2 | LLM-модель | Конфигурируемо через `STRATEGY_ANALYST_MODEL`, default `anthropic/claude-sonnet-4-6`. |
| 3 | Embeddings/pgvector | **Отложены в SP-3.** Дедупликация в SP-2 — по детерминированному `sourceFingerprint`. |
| 4 | Тестируемость агента | `StrategyAnalystPort` + `FakeStrategyAnalyst` (offline) + `MastraStrategyAnalyst` (real). |
| 5 | Adapter selection | `STRATEGY_ANALYST_ADAPTER=fake\|mastra`, **default `fake`**. No silent model calls. |
| 6 | LLM audit | Минимальные `agent_event` вокруг реального вызова: `strategy_analyst.started/completed/failed`. |

### Границы фазы

**В scope:** Mastra `Agent` adapter, `StrategyAnalystPort` (fake + mastra), `AnalystProfileOutput` (Zod) v1, `StrategyProfile` v1 + `StrategyProfileRepository` (in-memory + Drizzle, миграция, UNIQUE по fingerprint), детерминированный onboarding handler (заменяет `echoHandler` для `strategy.onboard`), `HandlerDeps`→services-bag рефактор, минимальный LLM-audit через `AgentEventRepository`, конфиг, тесты.

**Вне scope (later):** pgvector/embeddings и semantic dedupe (SP-3), Critic agent (SP-3), Mastra workflows/server/suspend-resume (SP-4), отдельная `artifact_ref` table (SP-4 — когда появятся backtest-артефакты; в SP-2 source ref хранится JSONB-колонкой), параметрический sweep/build/backtest (SP-3+).

---

## 1. Доменные типы и схемы (Zod)

### 1.1 SourceKind и StrategyAnalystInput

`strategy.onboard` task payload нормализуется в `StrategyAnalystInput`:

```ts
type SourceKind =
  | 'bot_code' | 'readme' | 'article'
  | 'notebooklm_summary' | 'manual_description' | 'crawler';

interface StrategyAnalystInput {
  kind: SourceKind;
  content: string;      // raw source text/code
  uri?: string;         // optional provenance
  title?: string;       // optional human label
}
```

Zod: `StrategyAnalystInputSchema` — `kind` enum, `content` `min(1)`, `uri`/`title` optional.

### 1.2 AnalystProfileOutput v1 (structured output агента)

Это то, что LLM возвращает как `result.object`. Валидируется Mastra (structuredOutput) **и** повторно нашим детерминированным `Validator` (наш gate).

```ts
interface StrategyParameter {
  name: string;
  value?: string | number | boolean | null;
  unit?: string | null;
  description: string;
  tunable: boolean;
}

interface AnalystProfileOutput {
  direction: 'long' | 'short' | 'both' | 'unknown';
  coreIdea: string;                 // 1–2 предложения
  summary: string;                  // развёрнутое описание
  requiredMarketFeatures: string[]; // напр. ['oi','funding','cvd']
  entryConditions: string[];
  exitConditions: string[];
  timeframes: string[];             // напр. ['5m','1h'] (заменяет timeframe: string|null)
  indicators: string[];             // именованные индикаторы из источника
  parameters: StrategyParameter[];  // параметры стратегии (tunable помечены)
  watchLifecycleSummary?: string | null;     // как стратегия следит/просыпается
  positionManagementSummary?: string | null; // вход/добор/частичные выходы
  riskManagementSummary?: string | null;      // SL/размер/лимиты (как описано в источнике)
  runnerOwnedAuthorities: string[];  // что относится к runner/platform (risk sizing, fills, execution) — подкрепляет границу
  confidence: number;               // 0..1
  unknowns: string[];
  evidence: string[];               // цитаты/ссылки из источника
}
```

Zod-схема `AnalystProfileOutputSchema`:
- `direction` enum; `confidence` `z.number().min(0).max(1)`;
- массивы строк — `z.array(z.string())` (могут быть пустыми, кроме где явно `min`);
- `parameters` — `z.array(StrategyParameterSchema)`; `value` — `z.union([z.string(), z.number(), z.boolean(), z.null()]).optional()`;
- summaries — `z.string().nullish()`.

Каждое поле снабжается `.describe(...)` — Mastra передаёт описания в модель, это улучшает структурированный вывод.

### 1.3 StrategyProfile (персистентная сущность)

```ts
interface StrategyProfile {
  id: string;                       // lab-generated uuid
  version: number;                  // 1 в SP-2
  sourceKind: SourceKind;
  sourceFingerprint: string;        // sha256:<hex> (см. §3)
  direction: AnalystProfileOutput['direction'];
  coreIdea: string;
  requiredMarketFeatures: string[]; // нормализованная колонка (queryable)
  confidence: number;
  unknowns: string[];               // нормализованная колонка
  profile: AnalystProfileOutput;    // полный канонический объект (JSONB)
  sourceArtifactRef: ArtifactRef;   // полный ArtifactRef (JSONB, см. §4)
  contractVersion: string;          // 'strategy-profile-v1'
  createdAt: string;
  updatedAt: string;
}
```

---

## 2. Ports & adapters

### 2.1 StrategyAnalystPort

```ts
interface StrategyAnalystPort {
  readonly adapter: 'fake' | 'mastra';  // для audit
  readonly model: string;               // для audit ('fake' для fake)
  analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput>;
}
```

- **`FakeStrategyAnalyst`** — `adapter='fake'`, `model='fake'`. Детерминированный canned `AnalystProfileOutput` (опционально настраиваемый через конструктор для разных тест-кейсов). Никаких сетевых вызовов.
- **`MastraStrategyAnalyst`** — `adapter='mastra'`, `model=env.STRATEGY_ANALYST_MODEL`. Конструктор: `(model: string)` создаёт `new Agent({ id, name, instructions, model })`. `analyze` строит prompt из `StrategyAnalystInput` и вызывает `agent.generate(prompt, { structuredOutput: { schema: AnalystProfileOutputSchema } })`, возвращает `result.object`. Требует `ANTHROPIC_API_KEY` в окружении.

`instructions` агента: system-prompt «ты аналитик торговых стратегий; извлеки структурированный профиль; не выдумывай; помечай неизвестное в `unknowns`; то, что относится к risk/execution/fills — в `runnerOwnedAuthorities`; не предлагай live-исполнение».

### 2.2 StrategyProfileRepository

```ts
interface StrategyProfileRepository {
  create(profile: StrategyProfile): Promise<void>;               // throw на duplicate id
  findById(id: string): Promise<StrategyProfile | null>;
  findByFingerprint(fp: string): Promise<StrategyProfile | null>;
}
```

- `InMemoryStrategyProfileRepository` (throw на duplicate id; linear scan по fingerprint).
- `DrizzleStrategyProfileRepository` + таблица `strategy_profile` (см. §5), **UNIQUE index на `source_fingerprint`** как DB-level dedupe guard (паттерн SP-1).

### 2.3 AgentEventRepository (LLM-audit, §6)

```ts
interface AgentEvent {
  id: string;
  taskId: string;
  type: string;                       // 'strategy_analyst.started' | '...completed' | '...failed' | 'strategy.onboard.deduped'
  payload: Record<string, unknown>;
  createdAt: string;
}
interface AgentEventRepository {
  append(event: AgentEvent): Promise<void>;
  listByTask(taskId: string): Promise<AgentEvent[]>;   // для audit/тестов
}
```

- `InMemoryAgentEventRepository` + `DrizzleAgentEventRepository`. Таблица `agent_event` **уже существует** (миграция SP-1) — добавляется только репозиторий.

---

## 3. Source fingerprint (детерминированный, safe)

```
sourceFingerprint = 'sha256:' + sha256( sourceKind + '\0' + canonicalContent )
canonicalContent = NFC( trim( crlfToLf(content) ) )
```

- `crlfToLf`: заменить `\r\n` и `\r` → `\n`.
- `NFC`: Unicode-нормализация `content.normalize('NFC')`.
- `trim`: обрезать ведущие/замыкающие пробелы.
- **НЕ** схлопывать internal whitespace — для `bot_code` это давало бы ложные совпадения.
- Префикс `sourceKind + '\0'` разделяет одинаковый текст, поданный как разные виды источника.

Дедупликация: handler вызывает `findByFingerprint` **до** обращения к LLM → повторный онбординг того же источника идемпотентен и **не тратит токены**.

---

## 4. Artifact storage

- Текст источника сохраняется через существующий `ArtifactStorePort.put(content, { kind: 'strategy_source', mime_type, producer: 'strategy-onboarding', metadata: { sourceKind, uri?, title? } })` → возвращает `ArtifactRef`.
- `strategy_profile.source_artifact_ref` хранит **полный `ArtifactRef` как JSONB** (не только `uri`/string): `{ artifact_id, uri, content_hash, kind, size_bytes, mime_type, created_at, producer, metadata }`.
- Отдельная `artifact_ref` table **не вводится** в SP-2 (придёт в SP-4 с backtest-артефактами).

---

## 5. Storage model — таблица `strategy_profile`

Нормализованные колонки + JSONB. Drizzle (`pg-core`), миграция через drizzle-kit.

```
strategy_profile:
  id                        text PK
  version                   integer notNull default 1
  source_kind               text notNull
  source_fingerprint        text notNull         -- UNIQUE index (dedupe guard)
  direction                 text notNull
  core_idea                 text notNull
  required_market_features  jsonb notNull        -- string[]
  confidence                real notNull
  unknowns                  jsonb notNull        -- string[]
  profile                   jsonb notNull        -- полный AnalystProfileOutput
  source_artifact_ref       jsonb notNull        -- полный ArtifactRef
  contract_version          text notNull         -- 'strategy-profile-v1'
  created_at                timestamptz notNull defaultNow
  updated_at                timestamptz notNull defaultNow
  UNIQUE index uq на (source_fingerprint)
  index на (source_kind)
```

Канон — Postgres; JSONB-колонки и нормализованные колонки оба канон (JSONB — детальный, колонки — queryable).

---

## 6. Onboarding handler (заменяет `echoHandler` для `strategy.onboard`)

Детерминированный handler; агент только рассуждает, handler решает и владеет side-effects; worker владеет lifecycle.

```
strategyOnboardHandler(task, services):
  1. schema-gate: validateWithSchema(StrategyAnalystInputSchema, task.payload) → input
       invalid → throw (worker помечает failed)
  2. fingerprint = sha256(sourceKind + '\0' + canonicalContent(input.content))
  3. dedupe: existing = services.strategyProfiles.findByFingerprint(fingerprint)
       if existing:
         services.events.append('strategy.onboard.deduped', { taskId, fingerprint, strategyId: existing.id })
         return            // идемпотентно; worker → completed; LLM НЕ вызывается
  4. store source: ref = services.artifacts.put(input.content, { kind:'strategy_source', mime_type, producer, metadata })
  5. audit: services.events.append('strategy_analyst.started', { taskId, model: analyst.model, adapter: analyst.adapter, sourceFingerprint })
  6. try:
       out = services.analyst.analyze(input)
     catch err:
       services.events.append('strategy_analyst.failed', { taskId, model, adapter, sourceFingerprint, error: message })
       throw err          // worker → failed
  7. audit: services.events.append('strategy_analyst.completed', { taskId, model, adapter, sourceFingerprint, direction: out.direction, confidence: out.confidence })
  8. gate: validateWithSchema(AnalystProfileOutputSchema, out) + domain-проверки (confidence∈[0,1], direction enum)
       invalid → throw
  9. build StrategyProfile (version 1; нормализованные колонки + profile JSONB + source_artifact_ref + contractVersion)
 10. services.strategyProfiles.create(profile)
```

**No silent model calls:** реальный вызов всегда обёрнут `started`/`completed`/`failed` событиями с `taskId`, `model`, `adapter`, `sourceFingerprint`.

---

## 7. Deps plumbing — `HandlerDeps` → `AppServices` (bounded refactor)

`HandlerDeps` из SP-1 (`{ repo }`) эволюционирует в services-bag:

```ts
interface AppServices {
  researchTasks: ResearchTaskRepository;
  strategyProfiles: StrategyProfileRepository;
  analyst: StrategyAnalystPort;
  artifacts: ArtifactStorePort;
  events: AgentEventRepository;        // нужен для §6 audit
}
type HandlerDeps = AppServices;        // handlers получают весь bag, используют нужное
```

Затрагивает SP-1 код (чистый, ограниченный рефактор):
- `src/orchestrator/workflow-router.ts` — `HandlerDeps` = `AppServices`.
- `src/worker/worker.ts` — `WorkerDeps = { queue, router, services: AppServices }`; worker **по-прежнему владеет** generic lifecycle (`running → completed/failed`), но использует `services.researchTasks` для статусов и передаёт `services` в `dispatch`.
- `src/orchestrator/handlers/echo.handler.ts` — no-op, не использует services (остаётся для router/worker-тестов).
- тесты router/worker — обновляются на `AppServices` (тест-фабрика `makeServices(overrides)` с in-memory/fake реализациями).
- `src/composition.ts` — строит `AppServices` и `WorkerDeps`.

> `repo` (research_task) переименовывается в `researchTasks` внутри bag — устраняет двусмысленность, когда репозиториев несколько.

---

## 8. Config (`env.ts` / `.env.example`)

Добавляются:

```
STRATEGY_ANALYST_ADAPTER=fake          # fake | mastra ; default fake
STRATEGY_ANALYST_MODEL=anthropic/claude-sonnet-4-6
ANTHROPIC_API_KEY=                      # required только если adapter=mastra
RUN_LLM_TESTS=false                     # 'true' включает live LLM integration tests
```

`loadEnv` парсит их. `composeRuntime`:
- `STRATEGY_ANALYST_ADAPTER==='mastra'` → требует `ANTHROPIC_API_KEY` (throw если пуст) + `STRATEGY_ANALYST_MODEL` → `new MastraStrategyAnalyst(model)`;
- иначе → `new FakeStrategyAnalyst()`.

Default `fake` ⇒ **никаких случайных платных вызовов** при обычном запуске/тестах.

---

## 9. Validation & safety

- **Schema gate #1:** `StrategyAnalystInputSchema` на payload (до LLM).
- **Schema gate #2:** `AnalystProfileOutputSchema` на вывод агента (наш детерминированный `Validator`, даже при Mastra-валидации) + domain-проверки (`confidence∈[0,1]`, `direction` enum).
- **Research-only сохраняется:** агент не имеет инструментов с side-effects; `runnerOwnedAuthorities` фиксирует, что risk/execution/fills — зона платформы; lab ничего не исполняет.
- **No silent model calls:** §6 audit-события обязательны вокруг реального вызова.
- **Идемпотентность:** dedupe по `sourceFingerprint` до LLM; `create` бросает на duplicate id; UNIQUE index на fingerprint — DB-level guard от гонки.
- **contract_version** на `StrategyProfile` (`'strategy-profile-v1'`) — защита от дрейфа схемы.

---

## 10. Testing

**Unit (offline, без сети; FakeStrategyAnalyst + in-memory repos + in-memory artifact store):**
- `AnalystProfileOutputSchema` / `StrategyAnalystInputSchema` — valid/invalid (включая `parameters[]`, `confidence` вне диапазона, неизвестный `direction`).
- `sourceFingerprint` — детерминизм; CRLF→LF и NFC дают одинаковый хеш; разный `sourceKind` → разный хеш; различие во внутренних пробелах bot_code → разный хеш (НЕ схлопывается).
- `FakeStrategyAnalyst` — возвращает schema-valid объект; `adapter='fake'`.
- `InMemoryStrategyProfileRepository` — create/findById/findByFingerprint; throw на duplicate id.
- `strategyOnboardHandler` — happy path (профиль персистится; `started`+`completed` события); dedupe-skip (LLM не вызывается; `deduped` событие; токены 0); invalid payload → throw + `failed`-путь; analyst throw → `failed` событие + rethrow.

**Integration (gated):**
- `DrizzleStrategyProfileRepository` (gated `DATABASE_URL`) + миграция; проверка UNIQUE на fingerprint (повторный create с тем же fingerprint → ошибка).
- `DrizzleAgentEventRepository` (gated `DATABASE_URL`) — append/listByTask.
- **MastraStrategyAnalyst live** — gated `RUN_LLM_TESTS=true` **и** `ANTHROPIC_API_KEY`; иначе `describe.skip`. Подаёт sample-источник, проверяет, что `analyze` возвращает schema-valid `AnalystProfileOutput`.

**E2E (offline, FakeAnalyst):**
- `POST /tasks {taskType:'strategy.onboard', payload: StrategyAnalystInput}` → worker → `strategyOnboardHandler` → `strategy_profile` строка создана, task `completed`, audit-события записаны.

---

## 11. Trade-offs

1. **Один fat `AppServices` bag** vs per-handler deps — проще плумбинг и тест-фабрика, ценой того, что handler видит сервисы, которые не использует. Приемлемо на текущем масштабе; при росте числа handlers можно сузить.
2. **`source_artifact_ref` как JSONB-колонка** vs нормализованная `artifact_ref` table — меньше схемы сейчас; миграция к таблице в SP-4 потребует backfill, но дешёвый (рефы самодостаточны).
3. **Повторная валидация вывода агента** нашим `Validator` поверх Mastra structuredOutput — дублирование, но держит наш детерминированный gate единственным источником истины и ловит domain-нарушения вне Zod.
4. **Default adapter `fake`** — безопасно/бесплатно по умолчанию, ценой того, что «боевой» прогон требует явного `STRATEGY_ANALYST_ADAPTER=mastra`.

---

## 12. Risks & simplifications

- **Risk: LLM возвращает невалидный/галлюцинированный профиль.** Митигация: structuredOutput (Zod) + наш gate + `unknowns`/`confidence`; артефакт-источник сохранён для аудита.
- **Risk: дрейф Mastra API.** Митигация: Mastra изолирован в `MastraStrategyAnalyst` за `StrategyAnalystPort`; остальной код от Mastra не зависит.
- **Risk: случайные платные вызовы.** Митигация: default `fake`; live-тесты только за `RUN_LLM_TESTS=true`+ключ; audit-события вокруг каждого реального вызова.
- **Risk: ложные дубли/пропуски при дедупе.** Митигация: safe fingerprint (NFC + CRLF→LF + trim, без collapse) + `sourceKind` префикс + UNIQUE index.
- **Simplification:** без embeddings/pgvector, без Critic, без Mastra workflows, без отдельной artifact_ref table — всё отложено в соответствующие фазы.

---

## 13. Outline тасков (для writing-plans)

1. Config: `STRATEGY_ANALYST_ADAPTER`/`MODEL`/`ANTHROPIC_API_KEY`/`RUN_LLM_TESTS` в `env.ts` + `.env.example`.
2. Domain: `SourceKind`, `StrategyAnalystInput`, `StrategyParameter`, `AnalystProfileOutput`, `StrategyProfile` + Zod-схемы.
3. `sourceFingerprint` утилита (+ тесты детерминизма).
4. `StrategyAnalystPort` + `FakeStrategyAnalyst`.
5. `MastraStrategyAnalyst` (+ `@mastra/core`, `@ai-sdk/anthropic`; live test gated).
6. `StrategyProfileRepository` port + in-memory.
7. Drizzle `strategy_profile` schema + repo + миграция (integration gated).
8. `AgentEventRepository` port + in-memory + Drizzle (integration gated).
9. `HandlerDeps`→`AppServices` рефактор (router/worker/echo + тесты).
10. `strategyOnboardHandler` (unit: persist/dedupe/invalid/analyst-fail).
11. Composition: adapter-selection + register `strategy.onboard` → onboarding handler; build `AppServices`.
12. E2E: ingress→worker→onboarding (FakeAnalyst) → профиль + completed.

---

*Конец SP-2 design. Реализация — после одобрения и перехода к writing-plans.*
