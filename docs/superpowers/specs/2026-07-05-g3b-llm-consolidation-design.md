# Slice G3b — LLM-консолидация ревизий в чистый source на промоушен-точках + re-baseline через G1

**Date:** 2026-07-05
**Status:** APPROVED — направление согласовано; 3 развилки подтверждены (триггер=порог вложенности; эквивалентность=строгий parity+fail-safe; Style-A НЕ спасать) + 5 правок ревью внесены (kind+link-поля; наследование hypothesisIds/mergedRuleSet от R; re-baseline как отдельный режим strategy.baseline с готовым bundleArtifactRef; run-context строго из фактического combo-рана; baselineValidationStatus отдельно от revision-статуса). Готово к writing-plans.
**Parent:** roadmap §8 гап G3b (см. `2026-07-03-strategy-revisions-design.md` §7 «вне scope G3»); поверх G3 (strategy_revision, composeRevisionBundle, StrategyRevisionRunExecutor, evaluateRevision) + G1 (strategy.baseline lane, reconstructStrategyBundle, bundleArtifactRef).

## 0. Контекст и мотивация

G3 ввёл детерминированное слияние: `revision.build` каждый цикл берёт `baseSource` = source **предыдущей accepted-ревизии** и оборачивает его новым IIFE-слоем + новые overlay-модули (`composeRevisionBundle` → `buildComposedSource`, namespace-изоляция через вложенные IIFE). Следствие: source ревизии v3 **текстово содержит** v2, который содержит v1 — глубина вложенности растёт линейно с числом принятых циклов. Source «сшит фрагментами», нечитаем, и с каждым циклом дороже валидируется/бандлится.

Параллельно: `paper.start` реконструирует и сабмитит **G1-baseline-бандл** (`reconstructStrategyBundle(baseline.bundleArtifactRef)`, гейт `wfo.bundleHash === baseline.bundleHash`), а НЕ ревизию. Ревизии и paper — **две несвязанные дорожки**: composed-ревизия живёт в ledger `strategy_revision` и кормит только researcher через `activeOverlayRules`; в paper она не попадает.

G3b закрывает оба: в точке промоушена схлопывает глубоко-стекнутую accepted-ревизию в **один плоский идиоматичный strategy-factory** и — при доказанной эквивалентности — заводит его **новым `strategy.baseline`** (re-baseline через полный G1-контур). Существующий контур G1→WFO→paper сам подхватывает чистую стратегию как first-class validated baseline; **нового paper-шва не требуется** (ключевая экономия). Следующий цикл гипотез стекается уже на чистую глубину-1.

## 1. Главный инвариант (жёсткий)

**LLM-консолидация не меняет семантику и не добавляет новых правил.** Consolidated-source обязан быть поведенчески-эквивалентной материализацией accepted-ревизии R — переписыванием, не улучшением. Если поведение изменилось (см. §6) — консолидация **отклоняется**, а stacked-ревизия R **остаётся source of truth** (accepted, latest). Консолидация fail-safe: она никогда не блокирует цикл, не аннулирует доказанную ревизию и не добавляет непровалидированную логику.

Производный инвариант (из G3 §3, сохраняется): единственный proof активности — accepted `strategy_revision`. Consolidated-ревизия наследует доказанность R (её эквивалентная форма), но НЕ вводит новых гипотез (§8).

## 2. Триггер — порог вложенности `[развилка 1]`

- Аддитивное поле `strategy_revision.composition_depth int` (default 1). Backfill существующих строк: depth = длина цепочки `baseRevisionId` от строки до корня (v1 bootstrap = 1). Обычный `revision.build` пишет `compositionDepth = accepted.compositionDepth + 1` на новую composed-ревизию; консолидация **сбрасывает в 1**.
- В `revision.build`, ПОСЛЕ ветки `revision.accepted` (Steps 9–10): если у только что принятой ревизии `compositionDepth >= LAB_CONSOLIDATION_DEPTH_THRESHOLD` (env, default **2**) → энкьюит новый task type `revision.consolidate` с `payload: { revisionId, strategyProfileId }`, `dedupeKey: revision.consolidate:${revisionId}`, `correlationId` цепочки. Ниже порога — ничего (стек продолжает расти дёшево, без обязательного re-baseline каждый цикл).
- Ручной ops-trigger (энкьюит `revision.consolidate` вручную) — совместим by construction, но НЕ реализуется в G3b (backlog).

## 3. Аддитивная миграция `strategy_revision` (поля G3b)

Новые nullable-поля (одна аддитивная миграция; existing строки backfill-ятся):

- `kind text NOT NULL DEFAULT 'composed'` — `'composed' | 'consolidated'`. Backfill всех существующих = `'composed'`.
- `consolidated_from_revision_id text NULL` — на consolidated-ревизии: id ревизии R, которую она материализует. NULL на composed.
- `semantic_parent_revision_id text NULL` — id ревизии, ЧЬЮ доказанную семантику эта строка материализует: composed → `base_revision_id` (accepted-ревизия, на которую добавили гипотезы); consolidated → `R.id` (§8). NULL только на bootstrap v1.
- `composition_depth int NOT NULL DEFAULT 1` — §2; backfill = длина `baseRevisionId`-цепочки.
- `baseline_validation_status text NULL` — `'pending' | 'passed' | 'inconclusive' | 'failed'`, только на consolidated-ревизии; исход re-baseline через G1 (§7). `inconclusive` ≠ `failed`: G1 мог просто не собрать evidence (short/data-gated) — это НЕ провал clean-source. NULL на composed.
- `baseline_experiment_id text NULL` — id `strategy.baseline`-эксперимента, валидировавшего clean-bundle (§7); доказуемая связка consolidated↔baseline. NULL на composed / до запуска.
- `baseline_task_id text NULL` — id task’а re-baseline (опционально, для трейсинга). NULL на composed / до запуска.

Доменный тип `StrategyRevision` расширяется теми же полями (`kind: 'composed' | 'consolidated'`, `consolidatedFromRevisionId?`, `semanticParentRevisionId?`, `compositionDepth: number`, `baselineValidationStatus?: 'pending' | 'passed' | 'inconclusive' | 'failed'`, `baselineExperimentId?`, `baselineTaskId?`). Repo `StrategyRevisionRepository`: `updateStatus`-расширение (патч `baselineValidationStatus` + `baselineExperimentId` + `baselineTaskId`) + запрос `findConsolidatedOf(revisionId)` (есть ли consolidated-ревизия с `consolidatedFromRevisionId=revisionId` — для идемпотентности §4) — аддитивно.

## 4. Хендлер `revision.consolidate`

Вход: `{ revisionId, strategyProfileId }` (revisionId = R.id). **Идемпотентность — retryable fail-safe (правка 4):** на входе `revisions.findConsolidatedOf(R.id)`; если consolidated-ревизия для R уже есть → no-op (`revision.consolidation_skipped {reason: already_consolidated}`). Иначе — выполнять, ДАЖЕ если прошлая попытка была отклонена: rejected-консолидация НЕ персистит строку/статус (§9), поэтому retryable by design (повторная доставка задачи заново вызовет LLM+бэктест — принятый trade-off; дешевле attempt-ledger). Последовательность:

1. **Загрузка R.** `revisions.findById(revisionId)`; guard: существует, `status==='accepted'`, `kind==='composed'`, `bundleArtifactRef` есть. Иначе `revision.consolidation_skipped {reason}`.
2. **Run-context — source of truth `[правка 4]`.** `run = await strategyBacktests.findById(R.comboBacktestRunId)`; `ctx = run?.platformRun`. Если `run` отсутствует ИЛИ `ctx == null` → **REJECT** `missing_run_context`, событие `revision.consolidation_rejected`, стоп. **Без fallback на `defaultPlatformRun`** — default мог дрейфовать с момента accept R, тогда сравнение с сохранёнными `R.metrics` было бы невалидным.
3. **S_stacked.** `reconstructStrategyBundle(artifacts, R.bundleArtifactRef)` → source + manifest.
4. **LLM-консолидация.** `consolidator.consolidate({ stackedSource, manifestMeta, mergedRuleSet: R.mergedRuleSet, theses })` → `StrategyBuilderOutput` (§5). Под token-budget kill-switch (correlationId). Ошибка/бюджет → REJECT `consolidator_error`, fail-safe.
5. **Сборка+валидация.** `assembleStrategyBundle(out)` → `validateStrategyBundle`. Rejected → REJECT `bundle_invalid`, fail-safe. Гарантия `assembleStrategyBundle` (self-contained, no imports) сохраняется.
6. **Гейт эквивалентности `[развилка 2]`.** Прогон S_clean через `revisionRunExecutor.execute({ revisionId: R.id, label: 'consolidation', strategyBundle: S_clean, strategyProfileId, run: ctx, metrics: RESEARCH_RUN_METRICS, correlationId })` на ТОМ ЖЕ `ctx` (`RevisionRunRequest.label`-union аддитивно расширяется `'consolidation'`; dedup-ключ revisionId+label не пересекается с 'candidate'/'comparison_baseline' ранами R). `evaluateConsolidation(clean.metrics, R.metrics, tol)` (§6). REJECT → `revision.consolidation_rejected {reasons, deltas}`, stacked R остаётся accepted/source-of-truth, **без re-baseline**, стоп. Run не completed → REJECT `consolidation_run_unavailable`.
7. **ACCEPT → материализация + re-baseline.**
   - `putBundleWrapper(S_clean)` → `bundleArtifactRef`.
   - Создать consolidated-ревизию (§8): `version = R.version + 1`, `kind='consolidated'`, `baseRevisionId=R.id`, `consolidatedFromRevisionId=R.id`, `semanticParentRevisionId=R.id` (материализует доказанную семантику именно R), `hypothesisIds=[...R.hypothesisIds]` (verbatim), `mergedRuleSet=R.mergedRuleSet` (verbatim), `bundleArtifactRef`/`bundleHash`, `comboBacktestRunId` = id рана из шага 6, `metrics` = clean.metrics, `compositionDepth=1`, `status='accepted'`, `baselineValidationStatus='pending'`, `verdictReason='consolidated_parity_ok'`. Гварда UNIQUE(profileId, version) как в revision.build (concurrent → skip).
   - Энкьюит `strategy.baseline` в режиме готового бандла (§7) с `payload: { strategyProfileId, bundleArtifactRef, consolidatedRevisionId: <new id> }`, `dedupeKey: strategy.baseline:consolidated:${newId}`.
   - События: `revision.consolidated { fromRevisionId: R.id, newRevisionId, version, bundleHash }`.

Consolidated-ревизия становится `findLatestAccepted` (макс. version) → **следующий цикл гипотез стекается на чистое** немедленно, не дожидаясь G1 (§8, правка 5).

## 5. Порт `StrategyConsolidatorPort` (шов)

```ts
interface StrategyConsolidateArgs {
  stackedSource: string;
  manifestMeta: StrategyManifestMeta;
  mergedRuleSet: Record<string, unknown>; // { order, rules, theses? } — семантический интент
  theses?: Record<string, string>;
}
interface StrategyConsolidatorPort {
  consolidate(args: StrategyConsolidateArgs): Promise<StrategyBuilderOutput>; // { source, manifestMeta }
}
```

- Задача LLM: переписать стекнутый source в ОДИН плоский `export default function`-factory той же семантики (те же решения `onBarClose`), без вложенных IIFE-слоёв, идиоматично. `mergedRuleSet.order/rules/theses` — интент-контекст, НЕ разрешение добавлять правила.
- Адаптеры: `FakeStrategyConsolidator` (детерминированный, для тестов — умеет и «эквивалентный», и «дивергентный» режим через фикстуру) + `MastraStrategyConsolidator` (LLM). Env-выбор `CONSOLIDATOR_ADAPTER` (`fake|mastra`, demo=fake) + `CONSOLIDATOR_MODEL`, зеркалит `buildStrategyBuilder`/`buildStrategyCritic`. Токен-учёт через существующий `makeOnUsage`/бюджет (correlationId).
- Промпт-контракт: выход — самодостаточный модуль без импортов (assembleStrategyBundle это проверит); никаких новых правил/условий сверх присутствующих в stackedSource.

## 6. `evaluateConsolidation` — строгий parity `[развилка 2]`

Чистая функция (зеркалит `evaluateRevision`), first-match над **всем скалярным набором `BacktestMetricBlock`** — не тремя полями. Обоснование (правка 2): совпадение только по `totalTrades/netPnl/maxDrawdown` НЕ доказывает идентичность семантики — можно совпасть по ним, но разойтись по win-rate / profit-factor / распределению сделок. Faithful-переписывание на том же детерминированном ctx даёт тот же набор сделок ⇒ идентичные метрики с точностью до float-reassociation; поэтому материальное расхождение в ЛЮБОМ поле = семантика изменилась.

```
evaluateConsolidation(clean, accepted, tol): { decision: 'ACCEPT'|'REJECT', reasons, deltas }
```

1. `clean.totalTrades !== accepted.totalTrades` (EXACT) → **REJECT** `trade_count_changed`.
2. Для каждого скалярного поля блока — `netPnlUsd`, `netPnlPct`, `winRate`, `profitFactor`, `expectancyUsd`, `maxDrawdownPct`, `sharpe`, `topTradeContributionPct` (и любое иное числовое поле, присутствующее в блоке) — `|clean.f - accepted.f| > max(tolAbs, tolRel * |accepted.f|)` → **REJECT** `metric_divergence:${f}` (с дельтой).
3. иначе → **ACCEPT** `parity_ok`.

Сравниваются только поля, реально присутствующие в ОБОИХ блоках (отсутствующее/undefined поле пропускается — не ложный REJECT). Дефолты (env, консервативные): `tolRel=0.001` (0.1%), `tolAbs=0.01`. Бар — «совпало», НЕ «не хуже»: улучшение любой метрики тоже REJECT (семантика изменилась). Все дельты — в событии для аудита.

## 7. Re-baseline — режим strategy.baseline с готовым бандлом `[правка 3]`

Сегодня `strategyBaselineHandler` ВСЕГДА зовёт `strategyBuilder.build(...)` → `assembleStrategyBundle` (LLM-ребилд, недетерминированный) и берёт контекст из `defaultPlatformRun`. Для G3b нельзя ребилдить: тот же недетерминизм даст `bundleHash != ` clean-source (класс бага, самоблокировавший WFO в G1). Изменения:

- `StrategyBaselinePayloadSchema` += опциональные `bundleArtifactRef?` (ArtifactRef готового `strategy_bundle`-артефакта) и `consolidatedRevisionId?` (string).
- В хендлере: если `bundleArtifactRef` задан → `bundle = reconstructStrategyBundle(artifacts, bundleArtifactRef)` (пропустить `strategyBuilder.build`; hash-pin из артефакта). Иначе — существующий build-путь без изменений. `runStrategyBaselineValidation({ strategyBundle: bundle, bundleArtifactRef, ... })` и wfo-автоцепочка неизменны; контекст baseline-валидации — штатный `defaultPlatformRun` (свежая независимая G1-валидация; parity уже доказал faithfulness на ctx R).
- **Writeback (правки 1,3):** если `consolidatedRevisionId` задан, при завершении baseline-валидации (в точке `strategy.baseline.completed`, где известны `experimentId` и `verdict`) хендлер патчит `revisions.updateStatus(consolidatedRevisionId, { baselineValidationStatus: map(verdict), baselineExperimentId: experimentId, baselineTaskId: task.id })`, где `map`: PASS→`passed`, INCONCLUSIVE→`inconclusive`, FAIL/ошибка→`failed` (INCONCLUSIVE ≠ FAILED — G1 мог просто не собрать evidence). Аддитивная опциональная связка; для не-G3b baseline’ов поля не трогаются.
- «paper/WFO через clean baseline — только после G1» удовлетворяется by construction: `paper.start` требует WFO-эксперимент `PAPER_CANDIDATE` с `bundleHash === baseline.bundleHash`, который существует лишь после завершения baseline→wfo. `baselineValidationStatus` — обозреваемость/аудит, не отдельный гейт.

## 8. Lineage и наследование consolidated-ревизии `[правки 1,2,5]`

- **kind + связи `[правка 1]`.** Consolidated-ревизия НЕ добавляет гипотез — это эквивалентная материализация R. `kind='consolidated'`, `consolidatedFromRevisionId=R.id` (какую R материализует), `semanticParentRevisionId=R.id` (чью доказанную семантику несёт — однозначно R, НЕ дальний корень). Composed-ревизия: `semanticParentRevisionId=baseRevisionId`. Цепочка версий однозначна: composed — «R + новые гипотезы», consolidated — «чистая форма R».
- **Наследование от R verbatim `[правка 2]`.** `hypothesisIds` и `mergedRuleSet` copied **без изменений** из R (source of truth = accepted R). НЕ пересобирать «всю цепочку» ad hoc. Следствие: `activeOverlayRules` для researcher из consolidated-ревизии = те же правила R, только source чище — семантически идентично, регрессий в researcher-контексте нет.
- **Usable для стекинга сразу, baseline — асинхронно `[правка 5]`.** parity OK → `status='accepted'` немедленно → `findLatestAccepted` возвращает consolidated → следующий цикл стекается на чистое. Независимо `baselineValidationStatus` идёт `pending→passed|inconclusive|failed` по мере G1. Выбран мягкий вариант (не «accepted только после G1 PASS»): тот переблокировал бы стекинг и дублировал parity-доказательство. Если G1-baseline упадёт (`failed`) — это сигнал в ledger о рассинхроне окружения, а не откат consolidated-ревизии (parity уже доказал эквивалентность на ctx R).

## 9. Обработка ошибок — fail-safe матрица

Любой из: `missing_run_context`, `consolidator_error`, `bundle_invalid`, `trade_count_changed`/`metric_divergence:*`, `consolidation_run_unavailable`, `concurrent_revision` → **stacked R остаётся accepted/source-of-truth**, событие `revision.consolidation_rejected {reason[, deltas]}`, **без re-baseline**, без новой ревизии. Depth продолжит расти (расхождение видно в ledger; на следующем пороговом accept консолидация ретрайнется на новой R). Консолидация НИКОГДА не fail-closed.

## 10. Оркестрация

- Новый task type `revision.consolidate` (аддитивно в `AGENT_TASK_TYPES`), регистрируется в composition. Триггер — из `revision.build` при `revision.accepted` && depth≥threshold (§2). Kill-switch: `LAB_CONSOLIDATION_DEPTH_THRESHOLD` не задан/0/∞ или `CONSOLIDATOR_ADAPTER` отсутствует → консолидация не энкьюится (стек растёт как в чистом G3).
- `AppServices` += `consolidator: StrategyConsolidatorPort`, `consolidationDepthThreshold: number`, `consolidationTolerances`. Composition wiring + `make-services` дефолты.

## 11. Тесты (контур)

1. `evaluateConsolidation`: полное совпадение→ACCEPT; trade-count drift→REJECT `trade_count_changed`; расхождение вне epsilon в ЛЮБОМ поле (netPnl / winRate / profitFactor / expectancyUsd / dd / sharpe)→REJECT `metric_divergence:${f}`; **win-rate/profit-factor разошлись при тех же total/net/dd→REJECT** (доказывает, что трёх метрик мало); отсутствующее в блоке поле пропускается (не ложный REJECT); улучшение метрики→REJECT (бар «совпало», не «лучше»).
2. Триггер: `revision.build` энкьюит `revision.consolidate` при depth≥threshold на accept, НЕ ниже; dedupe; depth растёт по цепочке; backfill depth корректен.
3. Happy: fake-эквивалент → parity ACCEPT → consolidated-ревизия (`kind='consolidated'`, `baseRevisionId=consolidatedFromRevisionId=semanticParentRevisionId=R.id`, depth=1, hypothesisIds/mergedRuleSet == R verbatim) + `strategy.baseline` энкьюится с `bundleArtifactRef`+`consolidatedRevisionId` + события.
4. Fail-safe: fake-дивергент (сдвиг trades) → REJECT → stacked R остаётся accepted, `consolidation_rejected` с deltas, baseline НЕ энкьюится, новой ревизии нет.
5. `missing_run_context`: combo-ран null/`platformRun==null` → REJECT без fallback на default.
6. Невалидный бандл от консолидатора → REJECT.
7. Style-A `[развилка 3]`: R с unsupported Style-A в `dropped` → consolidated.hypothesisIds ⊆ R.hypothesisIds (Style-A не подтягивается).
8. strategy.baseline ready-bundle режим: `bundleArtifactRef` задан → build пропущен, bundleHash стабилен (повтор → тот же hash); writeback при completed патчит `baselineValidationStatus` (map PASS/INCONCLUSIVE/FAIL → passed/inconclusive/failed) + `baselineExperimentId` на consolidated-ревизии.
9. Идемпотентность (правка 4): повтор при уже-существующей consolidated-ревизии для R → no-op (`already_consolidated`); повтор ПОСЛЕ rejection (consolidated-строки нет) → retryable, снова выполняет — тест обеих ветвей.
10. Token-budget kill-switch honored; аддитивные миграции + доменные типы.

## 12. Вне scope G3b

- Перевешивание уже-запущенного paper-кандидата на consolidated-ревизию (наследие G3 §7 — отдельный слайс).
- Re-admit Style-A data-only оверлеев (требует движкового rule-интерпретатора — отдельный слайс, зеркалящий тот интерпретатор).
- Ручной ops-trigger консолидации (backlog).
- Изменение движковой overlay-семантики / native overlay-on-submitted-baseline (третий handoff G3).

## 13. Риски и prerequisites

- **`platformRun` на combo-ране (prerequisite).** §4 шаг 2 зависит от того, что `BacktesterRevisionRunExecutor` персистит `platformRun` (PlatformRunConfig) на строку `revision_combo`-рана. В фикстурах поле бывает `null`. План ОБЯЗАН сначала проверить/обеспечить, что реальный executor пишет `platformRun` на completed combo-ран; иначе консолидация всегда `missing_run_context`. Если сегодня не пишет — аддитивно допишем в executor (первый шаг плана).
- **LLM-parity труден.** Faithful-переписывание, дающее байт-идентичный набор сделок — высокий бар; строгий parity часто будет REJECT'ить. Это ПРИЕМЛЕМО (fail-safe: стек остаётся), но метрику «доля успешных консолидаций» стоит логировать. Смягчение — дело промпта (дать stackedSource как reference), не ослабление гейта.
- **Стоимость.** Каждая консолидация = 1 LLM-вызов (крупная модель) + 1 полный strategy-lane ран (parity) + полный G1 re-baseline (baseline+WFO). Порог depth≥2 амортизирует; token kill-switch ограничивает LLM.
- **Расхождение default vs ctx.** Именно поэтому §4 берёт ctx из фактического combo-рана, не из default (правка 4) — сравнение с сохранёнными R.metrics валидно только на исходном контексте.
