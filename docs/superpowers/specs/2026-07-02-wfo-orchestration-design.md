# Slice G1 — WFO Orchestration: bundle-ref reconstruction + task types + budget gate

**Date:** 2026-07-02
**Status:** APPROVED — автоцепочка подтверждена пользователем; внесены 3 правки ревью (ArtifactRef-jsonb вместо text, ChainSpec-union + правило выбора цепочки, budget key = correlationId) + payload-формы. Готово к writing-plans.
**Parent:** `2026-06-30-backtest-research-orchestrator-roadmap.md` §8 гап G1.

## 1. Цель

Закрыть первый разрыв Цикла 1: baseline/WFO-контур сегодня — два ручных CLI-скрипта, причём WFO самоблокируется (LLM-ребилд бандла → `bundleHash ≠ baseline.bundleHash` → fail-fast). После слайса:

1. WFO **реконструирует** бандл из персистентного артефакта baseline-эксперимента, а не пересобирает его.
2. Baseline и WFO — оркестрированные task types, достижимые из чата: подтверждённый онбординг новой стратегии автоматически проходит воронку onboard → baseline → WFO (GATE1 внутри WFO сам решает «достаточно / sweep / стоп» — §3 roadmap).
3. WFO-контур уважает токен-бюджет (`RESEARCH_TASK_TOKEN_BUDGET`, correlationId-keyed) между LLM-раундами.

Вне scope: paper-мост (G2), ревизии/merge гипотез (G3), адаптивная длительность (G4), изменения TurnInterpreter-промпта.

## 2. Bundle-ref: персист и реконструкция (фикс самоблока)

**Схема.** `ArtifactStorePort.put()` возвращает **структурный `ArtifactRef`** (`{artifact_id, uri, content_hash, kind, size_bytes, mime_type, created_at, producer, metadata}` — src/domain/types.ts), и `artifacts.get(ref)` принимает весь объект, не строку. Поэтому аддитивная миграция: `research_experiment.bundle_artifact_ref jsonb NULL` (не text — отдельной lookup-таблицы артефактов по id/uri нет). Домен: `ResearchExperiment.bundleArtifactRef?: ArtifactRef`; drizzle-/in-memory-маппер сохраняет и восстанавливает объект целиком; поле проходит через `create`.

**Персист.** Вызывающая сторона (handler / CLI-скрипт) делает `services.artifacts.put(JSON.stringify({source, manifest, bundleHash}), {kind:'strategy_bundle', ...})` — как сегодня, но **не выбрасывает возвращённый `ArtifactRef`**, а передаёт его в `runStrategyBaselineValidation({..., bundleArtifactRef})`; сервис кладёт ref на строку эксперимента.

**Реконструкция.** Новый чистый хелпер `reconstructStrategyBundle(artifacts: ArtifactStorePort, ref: ArtifactRef)` (src/domain или src/research): `artifacts.get(ref)` → parse `{source, manifest, bundleHash}` → `assembleStrategyBundle({source, manifest})` → **инвариант**: пересчитанный `bundleHash` обязан равняться сохранённому (порча/дрейф → fail-fast с внятной ошибкой). WFO-путь (handler и CLI) использует только реконструкцию; guard `bundleHash === baseline.bundleHash` в `runWalkForwardOptimization` остаётся (теперь проходит по построению).

Если у baseline-эксперимента ref отсутствует (старые строки) — WFO падает с actionable-ошибкой «re-run baseline» (без fallback на ребилд: недетерминизм — источник исходного бага).

## 3. Task types + автоцепочка

**Payload-формы (единый источник истины):** `strategy.baseline` = `{strategyProfileId, sourceTaskId?}`; `strategy.wfo` = `{baselineExperimentId}` — strategyProfileId WFO **всегда** берёт из baseline-эксперимента (`baseline.strategyProfileId`), второго источника не заводим.

**`strategy.baseline`** (handler `strategyBaselineHandler`): payload `{strategyProfileId, sourceTaskId?}`.
Профиль → `strategyBuilder.build` (LLM) → `assembleStrategyBundle` → `artifacts.put` → ref → `runStrategyBaselineValidation({..., bundleArtifactRef})` (datasetScope/runConfig из `services.defaultPlatformRun`, метрики `RESEARCH_RUN_METRICS`) → события → **enqueue `strategy.wfo`** `{baselineExperimentId, strategyProfileId}` тем же correlationId.
Гейт цепочки: WFO ставится всегда, когда baseline-эксперимент дошёл до `status='completed'` (включая INCONCLUSIVE — GATE1 умеет `entrySignalEvidence` для 0-trade baseline); при `status='failed'` цепочка обрывается с событием.

**`strategy.wfo`** (handler `strategyWfoHandler`): payload `{baselineExperimentId}`.
Baseline-эксперимент → `strategyProfileId` из него → `bundleArtifactRef` → реконструкция (§2) → `runWalkForwardOptimization({baselineExperimentId, strategyBundle, profile, datasetScope: baseline.datasetScope, runConfig: из baseline.datasetScope + defaultPlatformRun.seed, metrics, taskId, correlationId})` → событие завершения с `{experimentId, verdict, terminalReason}`.

**Регистрация** обоих в `composition.ts` рядом с существующими пятью. События — по образцу существующих (`strategy.baseline.started/completed`, `strategy.wfo.started/completed`) — хук для Phase E.

**Чат / ChainSpec.** Сегодня `ChainSpec` (src/chat/guard.ts:33) жёстко типизирован: `nextTaskType: 'research.run_cycle'`. Расширяем:
- `nextTaskType: 'research.run_cycle' | 'strategy.baseline'` (union, не generic-string — диспатч остаётся исчерпывающим);
- chain-runner (`advanceChatPlan`, src/orchestrator/chain-runner.ts) учится строить payload для `strategy.baseline` из resolved profile id (тот же `resolveProfileByFingerprint`-механизм, что у run_cycle);
- **правило выбора цепочки** (явное): обычный онбординг новой стратегии (subject `strategy`, goal НЕ `research`) после confirm чейнит `strategy.baseline`; явный запрос «исследуй/улучши существующую стратегию» (goal `research`) — как раньше `research.run_cycle`. Старый путь сохраняется отдельной веткой, не заменяется.

Текст proposal для онбординга явно говорит, что после него автоматически пойдут baseline-бэктест и, по решению GATE1, sweep. TurnInterpreter не трогаем (schema/prompt eval'нуты — риск регрессии).

## 4. Budget kill-switch в WFO

**Ключ бюджета = `task.correlationId`, не `taskId`** (иначе kill-switch фиктивен: usage списывается по correlationId через `TokenUsageRepository.addCost(correlationId,...)`, а проверка по taskId всегда видела бы ноль). Контракт:
- `RunWfoInput` получает обязательный `correlationId` (chain key всей воронки onboard→baseline→wfo);
- handler передаёт `task.correlationId`; CLI-скрипт — свой сгенерированный;
- LLM-адаптеры WFO-агентов (gate1 / sweep-designer / result-interpreter) пишут usage в ТОТ ЖЕ correlationId через существующий `onUsage`-механизм;
- проверка читает `services.tokenUsage.get(correlationId)`.

Точка входа раундового цикла `runWalkForwardOptimization`: **перед GATE1 и перед каждым следующим sweep-раундом** — `withinTokenBudget(services.tokenUsage.get(correlationId), budget)` (существующий `src/orchestrator/token-budget.ts`; бюджет — `RESEARCH_TASK_TOKEN_BUDGET`).
Превышение до GATE1 → verdict `INCONCLUSIVE`, terminalReason `budget_exhausted`. Превышение между раундами → цикл останавливается; если interpreter уже сделал `select` — holdout-прогон выполняется (это бэктест, не LLM), иначе `INCONCLUSIVE`/`budget_exhausted`. Заодно `RESEARCH_TASK_TOKEN_BUDGET` добавляется в `.env.example` + docker-оверлеи (давний хвост PR#86).

## 5. CLI-скрипты

- `run-strategy-baseline.mts`: передаёт `bundleArtifactRef` (put уже есть — просто перестать выбрасывать ref).
- `run-strategy-wfo.mts`: шаг 3 (LLM-ребилд) и pre-flight hash guard **удаляются**, вместо них реконструкция из `baseline.bundleArtifactRef`; env-требования `BUILDER_ADAPTER`/`MODEL_PROVIDER` для этого скрипта отпадают (LLM остаются только у трёх WFO-агентов). KNOWN LIMITATION-блок в шапке убирается.
- Оба остаются ops-инструментами (ручной прогон/отладка); оркестрация — через task types.

## 6. Тесты (TDD, существующие паттерны)

1. Домен/репо: `bundleArtifactRef: ArtifactRef` round-trip как jsonb-объект (drizzle + in-memory), миграция аддитивна.
2. `reconstructStrategyBundle`: happy path; порченый артефакт → hash-mismatch fail-fast; отсутствующий ref → actionable error.
3. `strategyBaselineHandler`: с fake builder/experiment-service — персист ref, enqueue `strategy.wfo` on completed, обрыв цепочки on failed.
4. `strategyWfoHandler`: реконструкция вместо ребилда (fake artifacts), guard проходит; отсутствие ref → ошибка.
5. Budget gate: бюджет исчерпан до GATE1 → `budget_exhausted`; между раундами → остановка, select-ветка доигрывает holdout; **ключ-консистентность** — usage, записанный fake-агентами через onUsage в correlationId, виден проверке (регресс-тест на «проверяем по taskId, списываем по correlationId»).
6. Интеграционный: onboard → baseline → wfo chain на in-memory инфраструктуре + fake-агентах (образец — new-strategy-holdout.integration.test.ts).
7. Chat/chain: `ChainSpec` union принимает `strategy.baseline`; chain-runner строит baseline-payload по resolved profile; правило выбора цепочки (goal `research` → run_cycle, иначе → baseline); proposal-текст упоминает воронку.

## 7. Рассмотренные альтернативы

- **Ручные шаги из чата** (оператор сам дёргает baseline, потом sweep): больше контроля затрат, но воронка не автономна — противоречит §3 roadmap. Отклонено (затраты и так гейтятся confirm'ом онбординга + бюджетом §4; demo-стек по умолчанию на fake-адаптерах).
- **Единый task type `strategy.validate`** (baseline+WFO в одном хендлере): проще диспатч, но худшие retry/resume-свойства и беднее события. Отклонено.
- **Fallback на LLM-ребилд при отсутствии ref**: отклонено — возвращает недетерминизм, ради устранения которого слайс и делается.

## 8. Риски

- Автоцепочка тратит реальные LLM+backtester-раунды на каждый подтверждённый онбординг — митигируется confirm-гейтом, бюджетом (§4) и тем, что GATE1 может остановить воронку за один дешёвый вызов.
- Существующие строки research_experiment без ref — WFO по ним потребует пере-прогона baseline (осознанно).
- live tradeCount=0 (G7) не решается этим слайсом: живой прогон воронки до его починки будет давать INCONCLUSIVE — ожидаемо.
