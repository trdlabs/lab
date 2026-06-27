# F1: Strategy-Bundle Authoring (детерминированный stand-in) — Design

**Date**: 2026-06-27
**Branch**: `feat/strategy-bundle-authoring`
**Status**: Approved design → writing-plans

## Контекст и цель

Кросс-репо цель (#long-oi, переопределённая): доказать, что LLM-билдер lab генерирует strategy-бандл, чьи результаты совпадают с curated. Цепочка: **lab авторит → backtester (route+equivalence+sign, PR #58 в main) → platform (049 paper-proof vs curated long_oi, в main)**.

Платформенная и backtester-половины уже готовы. Остался lab. Lab сегодня **целиком overlay-ориентирован** (авторит hypothesis-оверлеи `export const overlay`, не self-contained strategy-модули). F1 добавляет **первую strategy-лейн**.

**Декомпозиция:**
- **F1 (этот дизайн)** — authoring-pipe + proof на **детерминированном stand-in** (без LLM). Доказывает lab authoring-механизм + lab→backtester delivery pipe.
- **F2 (follow-up)** — реальное LLM-авторство (Mastra) long_oi + iterate-until-proven loop; long_oi-specific proof на platform 049.

**Stand-in F1 = shortAfterPump twin.** Жёсткое ограничение backtester: `produceStrategyEvidence` подписывает только при equivalence vs trusted curated baseline; единственная trusted-стратегия в backtester — shortAfterPump (golden `0be9931c`). Поэтому F1 авторит shortAfterPump (тот же якорь, что #58). long_oi curated в backtester нет → long_oi proof = F2 на platform 049.

## Scope / Non-goals

**В scope:** новая strategy-лейн (author → assemble → validate → persist → submit → evidence), детерминированный shortAfterPump stand-in, оба тестовых тира (герметичный fixture + Docker integration), аддитивно к overlay-лейн.

**Не-цели:** LLM-авторство (F2); long_oi (F2 / platform-049); изменения overlay-лейн; обобщение `ModuleBundle`/builder в kind-параметрику (позже, если появится 3-й kind); live-authority (lab research-only).

## 1. Архитектура

Параллельная **strategy-лейн** в `trading-lab/src`, аддитивно к нетронутой overlay-лейн. Вход — новый orchestrator-handler `authorStrategyBundleHandler` (сиблинг `hypothesisBuildHandler`), для F1 управляемый детерминированным билдером.

Стадии (порты + F1-реализации):
1. **Author** — порт `StrategyBuilder`; F1 = `FakeStrategyBuilder` (фиксированный shortAfterPump `createStrategyModule` TS-source). Зеркало split `FakeBuilder`↔`builder.agent` → F2 подменит на `MastraStrategyBuilder`.
2. **Pre-build** — `assembleStrategyBundle`: esbuild TS→flat self-contained ESM + SDK `createModuleManifest({kind:'strategy', hooks:[onBarClose,onPositionBar], dataNeeds, paramsSchema})` + `computeBundleHash(rawBytes)`.
3. **Validate** — `validateStrategyBundle` = **композит**: SDK 017 `validate()` (manifest/contract) + self-contained/ambient-scan (безопасность кода, критично для F2-LLM) → `ValidationVerdict` (fail-closed; для strategy-пути вместо local `validateBundle`).
4. **Persist** — content-addressed артефакт через существующий artifact-store (`artifacts.put`, kind `strategy_bundle`).
5. **Handoff** — `submitStrategyRun` (новый метод backtester-порта) → backtester strategy-route equivalence + sign → signed evidence (`backtest-evidence/v1`).

**Тиры:** герметичный = `FixtureBacktesterAdapter` (программируемый, canned по контракту); integration = `HttpBacktesterAdapter` против Docker-backtester.

**Границы:** overlay-лейн нетронут; research-only; кросс-репо контракт = Вариант 2 (`computeBundleHash` raw-bytes) + `backtest-evidence/v1`.

## 2. Компоненты + интерфейсы

```ts
// 1. Author (порт; F1=Fake, F2=Mastra-LLM)
interface StrategyBuilderInput {
  readonly spec: StrategyAuthoringSpec;        // F1: фикс shortAfterPump spec; F2: из profile/hypothesis
  readonly authoringDoc: string;               // SDK getAuthoringDoc('strategy')
}
interface StrategyBuilderOutput {
  readonly source: string;                     // createStrategyModule TS-source (entry)
  readonly manifestMeta: StrategyManifestMeta; // {hooks:[onBarClose,onPositionBar], dataNeeds, paramsSchema, capabilities}
}
interface StrategyBuilder { build(i: StrategyBuilderInput): Promise<StrategyBuilderOutput>; }

// 2. Pre-build (esbuild + SDK manifest + hash)
interface AssembledStrategyBundle {
  readonly bytes: Uint8Array;                  // flat self-contained ESM raw-байты
  readonly source: string;
  readonly manifest: BundleManifest;           // SDK createModuleManifest(kind:'strategy')
  readonly bundleHash: string;                 // computeBundleHash(bytes) = 'sha256:'+hex (Вариант 2)
}
function assembleStrategyBundle(o: StrategyBuilderOutput): Promise<AssembledStrategyBundle>;

// 3. Validate (КОМПОЗИТ: SDK 017 contract-validate + self-contained/ambient scan) — union;
//    throw ТОЛЬКО для неожиданного (esbuild crash, SDK недоступен)
type ValidationVerdict =
  | { status: 'valid' }
  | { status: 'rejected'; reason: string; violations: string[] };
function validateStrategyBundle(a: AssembledStrategyBundle): ValidationVerdict;

// 4. Persist (существующий artifact-store)
//    artifacts.put(serialize(a), { kind: 'strategy_bundle' }) → content-addressed bundleRef

// 5. Handoff (расширение backtester-порта)
interface StrategyRunSubmission {
  readonly bundleBytes: Uint8Array;
  readonly bundleHash: string;                 // 'sha256:'+hex (Вариант 2)
  readonly manifest: BundleManifest;
  readonly curatedBundleHash: string;          // 'sha256:'+hex raw-bytes sha256 trusted shortAfterPump — НЕ path/id/artifactRef
  readonly scope: { datasetRef: string; window: { fromMs: number; toMs: number }; symbols: string[]; timeframe: string };
}
interface StrategyRunResult {
  // 'equivalent' = resultHash == golden (РЕАЛЬНЫЙ HTTP сегодня; evidence отложен);
  // 'signed' = equivalence + signed evidence (fixture canned / будущий HTTP-evidence путь)
  readonly status: 'signed' | 'equivalent' | 'divergent' | 'rejected' | 'unavailable';
  readonly resultHash?: string;                // backtest result_hash (equivalent/divergent/signed)
  readonly evidence?: SignedBacktestEvidence;  // backtest-evidence/v1 — ТОЛЬКО при 'signed'
  readonly divergence?: { bar: number; field: string; expected: unknown; actual: unknown };
}
interface BacktesterStrategyPort { submitStrategyRun(s: StrategyRunSubmission): Promise<StrategyRunResult>; }
// impls: HttpBacktesterAdapter (real) + FixtureBacktesterAdapter (программируемый, герметичный тир)

// 6. Orchestrator
function authorStrategyBundleHandler(
  input: AuthorStrategyInput,
  deps: { builder: StrategyBuilder; artifacts: ArtifactStore; backtester: BacktesterStrategyPort },
): Promise<{ bundleRef: string; bundleHash: string; evidenceRef?: string; status: StrategyRunResult['status'] }>;
```

Каждый порт — одна ответственность, тестируется изолированно (fake/fixture impls).

## 3. Data-flow

```
spec → [Author] → {source, manifestMeta}
     → [Assemble] → {bytes, manifest, bundleHash=computeBundleHash(bytes)}
     → [Validate] → ValidationVerdict
         rejected ───────────────────────→ return {status:'rejected', violations}   (нет submit; fail-closed как нормальный flow)
         valid ↓
     → [Persist] → bundleRef = artifacts.put(serialize, {kind:'strategy_bundle'})
     → [Submit]  → backtester.submitStrategyRun({bytes, bundleHash, manifest, curatedBundleHash, scope})
                     ├ signed     → [Collect] evidenceRef = artifacts.put(evidence,{kind:'backtest_evidence'}) → {bundleRef, bundleHash, evidenceRef, status:'signed'}
                     ├ divergent  → {bundleRef, bundleHash, status:'divergent', divergence:{bar,field,…}}
                     ├ rejected   → {…, status:'rejected'}
                     └ unavailable→ {…, status:'unavailable'}   (graceful)
```

**Единый outcome-принцип:** ВСЕ не-happy исходы (`rejected`/`divergent`/`unavailable`) — нормальные возвраты со статусом; `throw` зарезервирован для инфра-неожиданностей. Сквозная консистентность (validate-verdict ↔ submit-status).

**Границы детерминизма:**
- F1 детерминирован end-to-end: Fake-builder (фикс source) → те же ESM-байты → тот же `bundleHash` → тот же backtest-результат → golden `0be9931c` → детерминированное evidence-body **(кроме провенанс-полей: `backtesterRunId`; в fixture-тире фиксируется для детерминизма)**. Cross-repo equivalence — на backtest **result_hash**, НЕ на байтах бандла (esbuild-байт-вариативность между версиями толерируется).
- F2 (LLM): недетерминизм только на стадии Author; всё ниже детерминировано от `source`.

**Два разных хеша — не путать:** `bundleHash` (Вариант-2, sha256 ESM-байтов, кросс-граничный пин) ≠ artifact-store `bundleRef` (content-hash хранилища). Evidence пинит `bundleHash`.

## 4. Error-handling

**Таксономия исходов (нормальные возвраты, НЕ исключения):**

| Статус | Источник | Бандл сохранён? | Evidence? |
|--------|----------|-----------------|-----------|
| `signed` | happy path | да | да |
| `divergent` | backtest ≠ curated (result_hash / per-trade) | да | нет |
| `rejected` | validate ∨ backtester gate (contract / capability / ambient) | да | нет |
| `unavailable` | backtester недоступен / timeout | да | нет |

**`throw` — только инфра-неожиданности:** esbuild crash (нерешаемый импорт), SDK-модуль не загрузился, artifact-store write fail, serialize error.

**Persist-before-submit — НАМЕРЕННОЕ решение (не имплицитный side-effect):**
- Content-addressed dedup (повторный author идентичного бандла → тот же `bundleRef`).
- `unavailable`/`divergent`/`rejected` сохраняют бандл → **идемпотентный retry submit без пересборки**.
- Бандл — durable authored-артефакт независимо от downstream-исхода. Evidence persist **только** при `signed`.
- Retry: `submitStrategyRun` идемпотентен по `(bundleHash, curatedBundleHash, scope)`; backtester дедупит по `bundleHash`.

**Fail-closed точки:**
- Validate `rejected` → нет submit. Self-contained/ambient-authority — внутри validate → `rejected{reason}` (так F2-LLM-петля обработает «плохой код» как retry, не crash). esbuild-нерешаемый-импорт → throw.
- Невалидный ∨ divergent бандл **никогда** не даёт evidence (нет sign) — зеркало backtester abort-before-sign.

**Graceful degradation:** `unavailable` → статус + сохранённый бандл, без throw; orchestrator/F2-loop ретраят позже.

## 5. Тестирование

**Тир 1 — герметичный fixture (`pnpm check`, детерминированный, без Docker/сети):**
- `FixtureBacktesterAdapter` — **программируемый**: возвращает заданный статус на submission (`signed` с canned-evidence по форме `backtest-evidence/v1`; `divergent` с canned bar/field-diff; `rejected`; `unavailable`). Любая ветка форсируется — таксономию НЕЛЬЗЯ покрывать только happy-path (принцип `paper_only`/`backtest_only` reconcile-харнесса).
- `author-strategy-bundle.test.ts` — happy-path → `signed`; ассерты: ESM self-contained, manifest `kind:'strategy'`+hooks, `bundleHash` формат `'sha256:'+hex`, bundleRef + evidenceRef сохранены.
- `strategy-outcomes.test.ts` — **форсит КАЖДЫЙ не-happy статус** → правильный статус, **persist-before-submit инвариант** (бандл сохранён на divergent/rejected/unavailable, evidence нет), идемпотентный retry (dedup).
- `assemble-strategy-bundle.test.ts` — esbuild→ESM self-contained, hash-формат, SDK-manifest shape.
- `validate-strategy-bundle.test.ts` — valid→`{valid}`; ambient/contract-violation→`{rejected,violations}`; esbuild-unbuildable→throw.
- **Детерминизм:** author→assemble дважды → идентичные bytes + bundleHash.

**Тир 2 — Docker integration (`*.integration.test.ts`, реальный backtester, гейтнутый):**
- `strategy-route-equivalence.integration.test.ts` — lab авторит shortAfterPump → `HttpBacktesterAdapter.submitStrategyRun` против РЕАЛЬНОГО Docker-backtester → `signed`; **golden `0be9931c`** (backtest authored == trusted shortAfterPump); **evidence.bundleHash == lab bundleHash** (пин сошёлся); Ed25519-подпись верифицируется над `canonicalize(body)`.

**Покрытие:** герметика — ВСЕ outcome-ветки + assemble/validate юниты + детерминизм; integration — реальный submit→equivalence→sign→golden + подпись/пин. Гейт = `pnpm check` EXIT 0; integration отдельно (Docker).

## Кросс-репо контракт (НЕ менять)

- **Формат бандла** = Вариант 2: flat self-contained ESM `export default createStrategyModule`; `bundleHash = computeBundleHash(rawBytes) = 'sha256:'+hex` сырых ESM-байтов.
- **Evidence** = `backtest-evidence/v1` (body + detached Ed25519 над `canonicalize(body)`, sorted-keys); `body.bundleHash` = тот же raw-bytes пин; платформа верифицирует против trusted-signers allowlist по `keyId`. Lab только потребляет/хранит evidence (не подписывает).
- Downstream: backtester (route+equivalence+sign #58) → platform admission (049 готов принять Variant-2 long_oi bytes в F2).

## Ассумпции / риски (resolve в writing-plans)

1. **Источник фиксированного shortAfterPump-source** — worked-пример strategy из SDK 0.3.0 (#57) ∨ порт/коммит shortAfterPump-логики в lab. Критерий: backtest == trusted shortAfterPump (golden `0be9931c` result_hash). Проверить доступность worked-примера на этапе плана.
2. **Точные SDK-сигнатуры** — `createModuleManifest`, `computeBundleHash`, `validate`, `getAuthoringDoc`, `scaffoldStrategyBundle` из `@trading-backtester/sdk` 0.3.0 / `@trading-platform/sdk` — пин против реального SDK в плане.
3. **`submitStrategyRun` wire-форма** — реальный backtester strategy-run endpoint (зеркало `submitOverlayRun`): подтвердить параметры submission + result-форму при планировании integration-тира.
4. **esbuild-конфиг** — `format:esm`, `platform:neutral`, `bundle:true`, `write:false` (как platform 049 / smoke_longoi_rails); детерминизм result_hash важнее байт-идентичности бандла.

## Resolution (post-grounding, 2026-06-27)

Ассумпции разрешены против реального кода (детали + сигнатуры — в плане `docs/superpowers/plans/2026-06-27-strategy-bundle-authoring.md`):
1. **Stand-in source** = байт-twin `module/index.js` из `trading-backtester/apps/backtester/test/fixtures/overlay/bundles/short-after-pump.bundle.json` (engine-code-path-идентичный trusted shortAfterPump → golden `0be9931c`). Порт verbatim. НЕ генерик SDK worked-пример.
2. **SDK** = `@trading-backtester/sdk` (`computeBundleHash`/`createModuleManifest`/`getAuthoringDoc`/`scaffoldStrategyBundle`); lab бампит **0.2.0→≥0.3.0**. `validate` 017 = `@trading-platform/sdk/validation` (pin 0.5.0). **esbuild — добавить в lab.**
3. **Backtester handoff (C-сплит):** plain `kind:'strategy'` HTTP submit (`POST /v1/runs` engine:'strategy') СУЩЕСТВУЕТ → `resultHash` == golden. **Signed-evidence через HTTP НЕ подключён** (`produceStrategyEvidence` zero-callers) → backtester follow-on. **Решение: integration-тир F1 доказывает `resultHash == golden` (статус `equivalent`); signed-evidence-handling в lab строится + тестируется герметично (canned); реальный signed-evidence-over-HTTP отложен.** F1 forward-совместим.

**Cross-repo follow-on:** backtester подключает `produceStrategyEvidenceForBundle` в worker/submit-путь → signed-evidence через HTTP (нужно для platform-admission ноги, F2/full-chain). Не блокирует F1.
