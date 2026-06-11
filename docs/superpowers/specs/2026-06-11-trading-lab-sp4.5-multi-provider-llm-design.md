# SP-4.5 — Multi-provider LLM configuration (design / spec)

**Дата:** 2026-06-11
**Тип:** preparatory slice (между SP-4 и SP-5)
**Статус:** approved (3 решения + 4 уточнения ниже)
**Предыдущее:** SP-4 Build & Backtest (PR #4)

---

## 0. Цель и проблема

Сейчас `MastraStrategyAnalyst` / `MastraResearcher` / `MastraCritic` / `MastraBuilder`
жёстко завязаны на `@ai-sdk/anthropic` и `ANTHROPIC_API_KEY` (все четыре адаптера —
байт-в-байт одинаковый паттерн: `const bareModelId = model.replace(/^anthropic\//, '')`,
throw при другом провайдере, `model: anthropic(bareModelId)`).

Для курсовой demo у проверяющего, скорее всего, будет `OPENAI_API_KEY`, а не
`ANTHROPIC_API_KEY`; также желательна опциональная поддержка OpenRouter.

**Цель:** общий `ModelProvider` factory для Mastra-агентов, чтобы они работали на
`anthropic | openai | openrouter` **без изменений domain/orchestrator-кода**.

---

## 1. Принятые решения

| Решение | Выбор |
|---|---|
| **OpenRouter** | Официальный `@openrouter/ai-sdk-provider` (не reuse openai baseURL). |
| **Provider selection** | Глобальный `MODEL_PROVIDER` + per-role override через prefix. |
| **Adapter shape** | Inject resolved `LanguageModel`; адаптеры provider-agnostic. |

---

## 2. Scope (узкий)

**В scope:** factory + 4 Mastra-адаптера + `env` + `composition` + тесты + `.env.example`.
**Вне scope:** platform gateway / SP-5; любая domain/orchestrator-логика кроме `env` +
`composition` + конструкторов адаптеров; не трогаем fake-адаптеры (остаются default).

---

## 3. Factory — `src/adapters/llm/model-provider.ts`

Чистый модуль, без Mastra/domain-связей.

```ts
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelProviderEnv {
  MODEL_PROVIDER: ModelProvider;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

/** Уточнение 1: exported + table-tested. */
export function parseRoleModel(
  env: ModelProviderEnv,
  roleModelId: string,
): { provider: ModelProvider; modelId: string };

/** Уточнение 2: возвращает структуру с label = original role model env value (для audit). */
export interface ResolvedModel {
  model: LanguageModelV2;   // AI SDK model, assignable to Mastra Agent `model`
  provider: ModelProvider;
  modelId: string;          // id после снятия prefix-override
  label: string;            // исходное значение role model env (для аудита/логов)
}

export function resolveLanguageModel(env: ModelProviderEnv, roleModelId: string): ResolvedModel;
```

### 3.1 `parseRoleModel` — правило prefix-override

Первый path-сегмент считается provider-override **только** если он ровно
`anthropic` / `openai` / `openrouter`; иначе весь id уходит к глобальному `MODEL_PROVIDER`.

```ts
function parseRoleModel(env, roleModelId) {
  const slash = roleModelId.indexOf('/');
  if (slash > 0) {
    const head = roleModelId.slice(0, slash);
    if (head === 'anthropic' || head === 'openai' || head === 'openrouter') {
      return { provider: head, modelId: roleModelId.slice(slash + 1) };
    }
  }
  return { provider: env.MODEL_PROVIDER, modelId: roleModelId };
}
```

**Таблица (table-test обязателен):**

| `roleModelId` | `MODEL_PROVIDER` | → `provider` | → `modelId` |
|---|---|---|---|
| `claude-sonnet-4-6` | `anthropic` | anthropic | `claude-sonnet-4-6` |
| `anthropic/claude-sonnet-4-6` (текущий default) | любой | anthropic | `claude-sonnet-4-6` |
| `openai/gpt-4o` | любой | openai | `gpt-4o` |
| `gpt-4o` | `openai` | openai | `gpt-4o` |
| `meta-llama/llama-3.1-70b` | `openrouter` | openrouter | `meta-llama/llama-3.1-70b` |
| `openrouter/anthropic/claude-3.5-sonnet` | любой | openrouter | `anthropic/claude-3.5-sonnet` |
| `google/gemini-flash-1.5` | `anthropic` | anthropic | `google/gemini-flash-1.5` |

**Документированный gotcha:** чтобы отправить OpenRouter-id, чей vendor — `anthropic`/`openai`,
нужно префиксовать `openrouter/` (иначе bare `anthropic/…` читается как прямой Anthropic).
Vendor-префиксы вне lab-набора (`meta-llama/…`, `google/…`) работают bare при
`MODEL_PROVIDER=openrouter`.

### 3.2 `resolveLanguageModel`

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export function resolveLanguageModel(env, roleModelId): ResolvedModel {
  const { provider, modelId } = parseRoleModel(env, roleModelId);
  let model: LanguageModelV2;
  switch (provider) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for MODEL provider "anthropic"');
      model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId);
      break;
    case 'openai':
      if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for MODEL provider "openai"');
      model = createOpenAI({ apiKey: env.OPENAI_API_KEY })(modelId);
      break;
    case 'openrouter':
      if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for MODEL provider "openrouter"');
      model = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(modelId);
      break;
  }
  return { model, provider, modelId, label: roleModelId };
}
```

> **Точные API/exports провайдеров и тип возврата** (`createOpenAI` vs `openai`,
> `createOpenRouter(...)(modelId)` vs `.chat(modelId)`, точный `LanguageModelV2`/иной тип,
> совместимый с `@mastra/core` Agent `model`) проверяются **в начале implementation plan**
> (см. §7). Ключи передаются явно, не через ambient env.

---

## 4. Адаптеры — provider-agnostic

Все четыре `Mastra*`-конструктора меняются с `(model: string)` на
`(model: LanguageModelV2, label: string)`:

```ts
// было
constructor(model: string) {
  this.model = model;
  const bareModelId = model.replace(/^anthropic\//, '');
  if (bareModelId.includes('/')) throw new Error(`… only supports Anthropic …`);
  this.agent = new Agent({ …, model: anthropic(bareModelId) });
}
// стало
constructor(model: LanguageModelV2, label: string) {
  this.model = label;                       // audit-строка без изменений
  this.agent = new Agent({ …, model });
}
```

- Уходит `import { anthropic } from '@ai-sdk/anthropic'` и prefix/throw-логика.
- `readonly model: string` (audit-label) сохраняется → колонки `builderModel` / `criticModel`
  и т.п. не меняются.
- Тип `LanguageModelV2` импортируется type-only (источник определяется в §7 — провайдерский
  re-export или `@ai-sdk/provider`).

---

## 5. Composition

`buildAnalyst` / `buildResearcher` / `buildCritic` / `buildBuilder` резолвят модель через factory;
per-builder `ANTHROPIC_API_KEY`-проверки **уходят в factory**:

```ts
import { resolveLanguageModel } from './adapters/llm/model-provider.ts';

function buildResearcher(env): ResearcherPort {
  if (env.RESEARCHER_ADAPTER === 'mastra') {
    const r = resolveLanguageModel(env, env.RESEARCHER_MODEL);
    return new MastraResearcher(r.model, r.label);
  }
  console.warn('[composition] RESEARCHER_ADAPTER is not "mastra"; using FakeResearcher (stub hypotheses)');
  return new FakeResearcher();
}
```

Аналогично для analyst/critic/builder. Default-адаптеры остаются `fake` →
`docker compose up` работает **без единого LLM-ключа**.

---

## 6. Env & dependencies

**env (`src/config/env.ts`):**

```
MODEL_PROVIDER: 'anthropic' | 'openai' | 'openrouter'   (default 'anthropic')
OPENAI_API_KEY?: string
OPENROUTER_API_KEY?: string
(ANTHROPIC_API_KEY уже есть)
```

`Env` структурно удовлетворяет `ModelProviderEnv` (есть `MODEL_PROVIDER` + три ключа),
поэтому `resolveLanguageModel(env, …)` принимает `env` напрямую.

**Новые зависимости:** `@ai-sdk/openai` + `@openrouter/ai-sdk-provider`, обе пиннятся к линии,
чей `@ai-sdk/provider` — `^3` (под установленный `@ai-sdk/anthropic@3.0.82` →
`@ai-sdk/provider@3.0.10`, `@ai-sdk/provider-utils@4.0.27`). **Главный риск** — version compat;
проверяется первым шагом плана (§7).

**Уточнение 3 — `.env.example` (три demo-сценария):**

```dotenv
# --- Demo A: no-key fake (default; docker compose up works without any LLM key) ---
# STRATEGY_ANALYST_ADAPTER / RESEARCHER_ADAPTER / CRITIC_ADAPTER / BUILDER_ADAPTER default to "fake"
# MODEL_PROVIDER and keys are irrelevant when adapters are fake.

# --- Demo B: OpenAI ---
# MODEL_PROVIDER=openai
# OPENAI_API_KEY=sk-...
# RESEARCHER_ADAPTER=mastra
# RESEARCHER_MODEL=gpt-4o
# (or per-role override regardless of MODEL_PROVIDER: RESEARCHER_MODEL=openai/gpt-4o)

# --- Demo C: OpenRouter ---
# MODEL_PROVIDER=openrouter
# OPENROUTER_API_KEY=sk-or-...
# RESEARCHER_ADAPTER=mastra
# RESEARCHER_MODEL=meta-llama/llama-3.1-70b-instruct
# (for an anthropic/openai vendor via OpenRouter: RESEARCHER_MODEL=openrouter/anthropic/claude-3.5-sonnet)
```

Текущие role-model defaults (`anthropic/claude-sonnet-4-6`) сохраняются — при
`MODEL_PROVIDER=anthropic` (default) поведение идентично сегодняшнему.

---

## 7. Implementation plan — обязательный первый шаг (Уточнение 4)

**До wiring всех адаптеров** план ОБЯЗАН проверить точные provider-API и version-compat:

1. Установить `@ai-sdk/openai` + `@openrouter/ai-sdk-provider` версий, чьи `@ai-sdk/provider`
   = `^3` (совпадают с `@ai-sdk/anthropic@3.0.82`). Зафиксировать точные версии.
2. В одном маленьком probe-файле/тесте убедиться, что:
   - `createAnthropic`, `createOpenAI`, `createOpenRouter` экспортируются и вызываются как ожидается;
   - `createX({ apiKey })(modelId)` (или `.chat(modelId)`) возвращает объект, **assignable**
     к `@mastra/core` Agent `model`;
   - выбран корректный тип возврата (`LanguageModelV2` или провайдерский re-export) для
     `ResolvedModel.model`.
3. `pnpm typecheck` зелёный на этом probe **до** правки адаптеров.

Только после зелёного probe — рефакторить factory → 4 адаптера → composition → env → тесты.

---

## 8. Testing

- **`model-provider.test.ts` (offline):**
  - `parseRoleModel`: вся таблица §3.1 (table-test).
  - `resolveLanguageModel`: на каждый провайдер — missing key → throws с понятным сообщением;
    с dummy-ключом → `ResolvedModel` определён, `provider`/`modelId`/`label` корректны,
    `model.modelId` (или эквив. поле) совпадает с ожидаемым (сеть не дёргается — `createX()`
    лишь строит объект).
- **4 `mastra-*.test.ts` construction-тесты:** ассерт «rejects non-Anthropic» **переезжает в
  factory-тест** (missing-key/throw). Adapter construction-тест теперь строит модель через
  factory с dummy-ключом и проверяет `adapter.model === label` + что `Agent` создаётся.
- **env-тест:** `MODEL_PROVIDER` default `anthropic`; чтение `OPENAI_API_KEY` / `OPENROUTER_API_KEY`.
- **Live-тесты:** остаются `describe.skip`, пока нет `RUN_LLM_TESTS=true` + соответствующего
  ключа провайдера. Обычные тесты — полностью offline/fake.

---

## 9. Соответствие требованиям

| Требование | Где |
|---|---|
| default adapters остаются fake | §5 (composition не меняет default) |
| `MODEL_PROVIDER=anthropic\|openai\|openrouter` | §3, §6 |
| `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY` | §3.2, §6 |
| общий factory для всех 4 ролей | §3, §5 |
| model id env-configurable per role + override | §3.1 |
| обычные тесты offline/fake | §8 |
| live tests gated `RUN_LLM_TESTS` + ключ | §8 |
| не менять SP-5 platform gateway | §2 |
