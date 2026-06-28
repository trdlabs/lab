# F2a: LLM Strategy Authoring (MastraStrategyBuilder) — Design

**Date**: 2026-06-28
**Branch**: `feat/llm-strategy-authoring`
**Status**: Approved design → writing-plans

## Контекст и цель

Кросс-репо цель (#long-oi): доказать, что LLM-билдер lab генерирует strategy-бандл, чьи результаты совпадают с curated long_oi. Цепочка-механизм собрана и проверена: **lab authoring-pipe (F1, merged) → backtester route+sign (#58) → platform 049 paper-proof**.

F1 доказал МЕХАНИЗМ авторства на детерминированном stand-in (FakeStrategyBuilder → фикс shortAfterPump). **F2 заменяет stand-in на реальное LLM-авторство long_oi.**

**Декомпозиция F2:**
- **F2a (этот дизайн) — постоянный билдер.** `MastraStrategyBuilder`: реальный LLM авторит long_oi `createStrategyModule` из профиля стратегии; drop-in замена `FakeStrategyBuilder` в готовом F1-пайпе. Часть production-lifecycle.
- **F2b (отдельный follow-on) — временный proof-каркас.** platform 049-ops-endpoint (тонкий) + lab iterate-until-proven петля vs curated long_oi → доказательство билдера. **Separable/removable** после milestone; билдер (F2a) остаётся. (Production для НОВЫХ стратегий: curated-эталона нет → петля = backtest-evidence + admission-гейты, не `== curated`.)

**Что постоянное vs временное:** постоянное — `MastraStrategyBuilder`, F1-пайп, backtester backtest+sign, platform admission+paper-runtime. Временное (proof-каркас) — iterate-vs-curated петля + 049-parity-endpoint.

## Scope / Non-goals

**В scope (F2a):** `MastraStrategyBuilder` (LLM-авторство из профиля), frozen-profile фикстура (real аналитик один раз), strict strategy-LLM-output схема, L1-уровень error-handling (внутри `build()`), типизированный feedback-вход (чтобы F2b мог гнать петлю), mock-LLM mechanism-тесты. Аддитивно к overlay-пути.

**Не-цели:** F2b (049-endpoint + iterate-loop + real-LLM proof — отдельный дизайн; platform-endpoint = платформенный таск); hypothesis-стадия (пропущена для strategy-пути — overlay-специфична); overlay-путь не трогаем; production admission-петля для новых стратегий.

## 1. Архитектура

Strategy-build путь, аддитивно к overlay-пути. Переиспользует существующие analyst + Mastra-каркас.

1. **Onboard (существующее)** — `long-oi-strategy-source.md` → `StrategyAnalystInput {kind:'strategy_text', content}` → `MastraStrategyAnalyst` → `StrategyProfile`. **F2a: real аналитик ОДИН раз → заморозить профиль как committed-фикстуру** (`long-oi-profile.json`; развязка от недетерминизма аналитика).
2. **Strategy build (НОВОЕ)** — `MastraStrategyBuilder.build({ profile, authoringDoc: getAuthoringDoc('strategy'), feedback? })` → реальный LLM → strict-схема (createStrategyModule source + manifestMeta) → `StrategyBuilderOutput` (F1-порт, через адаптер). Сиблинг overlay `MastraBuilder`; переиспользует Mastra agent/prompt-машинерию.
3. **Pipe (F1, существующее)** — `StrategyBuilderOutput → assembleStrategyBundle → validateStrategyBundle → artifacts.put` → (F2b: submit на platform 049).

**Решение:** strategy-путь **пропускает hypothesis-стадию** (overlay-специфична). Вход билдера = `{profile, authoringDoc}` (+ опц. `feedback` от предыдущей итерации F2b).

**Тиры:** герметичный (`pnpm check`) — mock-LLM → механизм билдера; real proof (eval-gated, F2b) — frozen profile → real LLM → assemble → validate → 049 parity == curated.

**Границы:** F2a = постоянный билдер (additive); F2b = временный separable proof-каркас.

## 2. Компоненты + интерфейсы

```ts
// 1. Frozen profile fixture: src/adapters/builder/fixtures/long-oi-profile.json (сериализованный StrategyProfile)
//    + regen-скрипт (real аналитик один раз).

// 2. F1-порт StrategyBuilder — аддитивно обогащаем (Fake игнорит новое):
interface StrategyBuilderInput {
  readonly spec: StrategyAuthoringSpec;
  readonly authoringDoc: string;          // getAuthoringDoc('strategy') + tools/examples
  readonly profile?: StrategyProfile;     // NEW: F2a; Fake игнорит
  readonly feedback?: BuildFeedback;       // NEW: F2b re-prompt (см. §4)
}
interface StrategyBuilder {
  readonly adapter: string; readonly model: string;                          // NEW (как overlay BuilderPort)
  build(i: StrategyBuilderInput, opts?: AgentCallOpts): Promise<StrategyBuilderOutput>;  // NEW opts (cost/token)
}

// 3. Strict strategy-LLM-output схема (LLM не протащит bundleHash/bytes — зеркало overlay BuilderOutputSchema):
const StrategyLlmOutputSchema = z.object({
  manifest: StrategyManifestSchema,       // kind:'strategy', hooks, dataNeeds, paramsSchema, capabilities…
  source:   z.string().min(1),            // createStrategyModule ESM-source
  notes:    z.string().optional(),
}).strict();
type StrategyLlmOutput = z.infer<typeof StrategyLlmOutputSchema>;

// 4. Адаптер LLM-выход → F1-порт:
function llmToStrategyBuilderOutput(o: StrategyLlmOutput): StrategyBuilderOutput {
  // { source: o.source, manifestMeta: <o.manifest без kind> }
}

// 5. MastraStrategyBuilder (сиблинг overlay MastraBuilder):
class MastraStrategyBuilder implements StrategyBuilder {
  // build(input, opts):
  //   userMsg = buildStrategyUserMessage(input.profile, input.feedback)
  //   out     = await <schema-valid StrategyLlmOutput от real LLM>  // Mastra structured-output ∨ generate+parse; L1-retry bounded N внутри
  //   return llmToStrategyBuilderOutput(out)
}
function createStrategyBuilderAgent(deps: { authoringDoc: string; … }): Agent;  // instructions = STRATEGY_INSTRUCTIONS + authoring-doc структурно
function buildStrategyUserMessage(profile: StrategyProfile, feedback?: BuildFeedback): string;

// 6. Mock (герметичный тир): инъектируемый fake-agent (DI-seam) → canned StrategyLlmOutput.
```

**Решения:** один порт `StrategyBuilder` (Fake + Mastra оба реализуют; drop-in swap); аддитивные поля порта Fake игнорит → F1 не ломается; strict-схема без `bundleHash` (хеш только в `assembleStrategyBundle`, Вариант-2).

## 3. Data-flow

```
long-oi-strategy-source.md → [Onboard, real аналитик ОДИН раз] → StrategyProfile
    → FROZEN → long-oi-profile.json (committed)
  ─────────────────────────────────────────────────────────────────────
  [Build]  frozen profile + getAuthoringDoc('strategy') (+ feedback?)
    → createStrategyBuilderAgent({ authoringDoc })   // agent.instructions = system: роль+правила
    │                                                //   + authoring-doc СТРУКТУРНО (### CONTRACT/HOOKS/TOOLS/EXAMPLES),
    │                                                //   статично, ОДИН раз на агента — НЕ инлайн в prompt-строку
    → buildStrategyUserMessage(profile, feedback?)   // per-call user: profile структурно + TASK (+ feedback)
    → agent.generate(userMsg, { schema: StrategyLlmOutputSchema, ...opts })   // Mastra structured output
    → StrategyLlmOutputSchema.parse(raw)  → llmToStrategyBuilderOutput → StrategyBuilderOutput
  → [F1-пайп] assembleStrategyBundle → validateStrategyBundle → artifacts.put
  → (F2b) submit → platform 049 parity vs curated → verdict (equivalent/divergent)
```

**Структура промпта (load-bearing для Mastra structured output):** authoring-doc (большой, статичный) → `agent.instructions` (system), структурированными секциями, собирается ОДИН раз в `createStrategyBuilderAgent` (НЕ конкатенируется в per-call строку). profile (+feedback) → per-call user-message. Качество strict-парсинга стабильнее.

**Границы детерминизма:** Onboard (real аналитик) — недетерминизм → ОДИН раз → freeze. **Build (real LLM) — единственный недетерминизм F2a** (стадия Author). Assemble/validate (F1) + 049 (F2b) — детерминированы от бандла. Mock-тир делает механизм детерминированным (canned).

## 4. Error-handling — 3-уровневая failure-таксономия

| Уровень | Где | Причина | Retry-семантика | Owner |
|---------|-----|---------|-----------------|-------|
| **L1 schema-parse fail** | `StrategyLlmOutputSchema.parse` | LLM вернул невалидный JSON/структуру/лишние поля | **немедленный retry того же запроса** (+ «match the schema» nudge), bounded N; profile/feedback НЕ меняем | **F2a** (внутри `build()`) |
| **L2 semantically-invalid code** | `assembleStrategyBundle` throw (esbuild не собрал) ∨ `validateStrategyBundle`→`rejected` | ambient authority / import / не self-contained / manifest-017 fail | **re-prompt с конкретными `violations`/esbuild-error** | **F2b-петля** |
| **L3 behaviorally-divergent** | platform 049 parity → `divergent` | код валиден+собрался, поведение ≠ curated | **re-prompt с bar/field diff** | **F2b-петля** |

**Типизированный feedback (разделяет уровни — иначе петля смешает structurally-invalid и semantically-divergent):**
```ts
type BuildFeedback =
  | { kind: 'validation'; violations: string[] }                          // L2
  | { kind: 'parity';     diff: { bar: number; field: string; expected: unknown; actual: unknown } };  // L3
```
F2b классифицирует исход и кладёт типизированный feedback в следующий `build()` — re-prompt тейлорится. L1 НИКОГДА не доходит до петли (поглощается в `build()`).

**Граница F2a ↔ F2b:**
- **F2a** = `build()`: получить **schema-валидный** `StrategyLlmOutput` в пределах bounded N (МЕХАНИЗМ L1 — Mastra-native structured-output retry ∨ build()-side `parse`+retry — резолвится в плане, ассумпции #1/#4; важно НЕ дублировать retry); на исчерпании `throw BuilderError`. Принять типизированный feedback и встроить в re-prompt. НЕ ассемблит/валидирует/сабмитит.
- **F2b-петля** (отдельный дизайн): `build → assemble → validate → submit049`; классифицирует L2 (validation) vs L3 (parity); кладёт typed feedback назад; до `equivalent` ∨ max-iter.

```
F2b loop (until equivalent | max-iter):
  out = builder.build({ profile, authoringDoc, feedback? })                  // L1 внутри
  try { bundle = assembleStrategyBundle(out) }
    catch(e) { feedback = {kind:'validation', violations:[esbuildError(e)]}; continue }   // L2
  verdict = validateStrategyBundle(bundle)
  if rejected:  feedback = {kind:'validation', violations}; continue                       // L2
  res = submit049(bundle); if divergent: feedback = {kind:'parity', diff: res.divergence}; continue  // L3
  if equivalent: DONE
```

**`throw` — только инфра** (LLM-провайдер недоступен, L1-исчерпание после N, artifact-store fail). L2/L3 — нормальные re-prompt-итерации.

## 5. Тестирование

**Тир 1 — Frozen profile (one-time setup + guard):**
- `scripts/regen-long-oi-profile.mts` — real аналитик ОДИН раз → `long-oi-profile.json` (committed). Gated (real LLM), НЕ в `pnpm check`.
- Hermetic guard: committed профиль парсится как валидный `StrategyProfile`.

**Тир 2 — Mock-LLM mechanism (герметичный, `pnpm check`):** `MastraStrategyBuilder` с инъектированным fake-agent + frozen profile:
- **happy** — canned валидный выход → system несёт authoring-doc структурно, user несёт profile, strict-parse+adapter → валидный `StrategyBuilderOutput`.
- **L1 exhaustion** — fake-agent ВСЕГДА невалиден → `build()` ретраит ровно **N** → `throw BuilderError` (НЕ бесконечно); call-counting ассертит число попыток == N.
- **L1 recovery** — невалиден первые N−1, валиден на N-й → успех (не сдаётся рано).
- **strict-schema reject** — протащено лишнее поле (`bundleHash`) → strict-parse режет.
- **typed-feedback incorporation** — `build({feedback:{kind:'validation',violations}})` → user-message содержит violations; `{kind:'parity',diff}` → содержит diff.

**Тир 3 — Real-LLM proof (eval-gated, F2b, НЕ `pnpm check`):** F2b-петля + real Mastra-agent + frozen profile → real LLM авторит long_oi → assemble → validate → submit 049 → parity vs curated → iterate-until-proven (≤ max-iter). Gated (`RUN_F2_PROOF=true` + real LLM + 049-endpoint). Это доказательство билдера; живёт в F2b.

**Что доказывает:** Тир 1 — профиль валиден+стабилен; **Тир 2 — МЕХАНИЗМ корректен+робастен** (bounded-retry без infinite-loop, strict-schema, feedback-re-prompt) в CI; Тир 3 — **билдер РАБОТАЕТ** (real LLM → long_oi == curated). Гейт: `pnpm check` EXIT 0 (тиры 1-guard + 2); Тир 3 отдельно.

## Кросс-репо / границы

- F2a = постоянный билдер (lab). F2b = временный proof-каркас: lab iterate-loop + **platform 049-ops-endpoint (платформенный таск, моя сторона)** — тонкий proof-инструмент, не production-сервис.
- Контракт формата = Вариант 2 (computeBundleHash raw-bytes; F1-пайп). strict-схема не позволяет LLM протащить доверенные поля.
- Параллельные треки (не блокеры F2a): backtester evidence→HTTP; lab SDK-017 bump (усилит `validateStrategyBundle` → L2 строже).

## Ассумпции / риски (resolve в writing-plans)

1. **Mastra structured-output API** — точная сигнатура `agent.generate(msg, {schema})` (∨ аналог) против установленного Mastra; как инъектировать fake-agent (DI-seam overlay `MastraBuilder`).
2. **StrategyProfile shape** — точная схема (`src/domain/strategy-profile.ts`) для frozen-фикстуры + user-message сериализации.
3. **getAuthoringDoc('strategy') размер/формат** — структурировать в system-instructions секциями (НЕ инлайн).
4. **L1 N** — выбрать bounded N (напр. 3); подтвердить, что Mastra retas сам не ретраит (иначе двойной retry).
5. **StrategyManifestSchema** — переиспользовать F1 `StrategyManifestMeta` (= Omit<CreateModuleManifestInput,'kind'>) для strict-схемы manifest-части.
