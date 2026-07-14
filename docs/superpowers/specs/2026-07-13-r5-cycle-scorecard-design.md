# R5 — Cycle Scorecard (детерминированный versioned артефакт закрытого цикла)

**Дата:** 2026-07-13
**Статус:** design approved (brainstorming), ready for writing-plans
**Источник:** hypothesis-eval review `docs/research/2026-07-11-hypothesis-evaluation-workflow-review.md` §R5 (+§R7). Первый слайс после R1/R2/R3a/R3b-1/R4 (все в main).

## 0. Декомпозиция (важно)

Ревью дизайна выявило, что решающие входы оценки (baseline/thresholds/holdout-verdict) **не персистятся** сегодня, а R5 без них не объясним. Поэтому слайс делится:

- **R5a — Persistence decision-inputs (upstream, предпосылка):** revision-build сохраняет типизированный `selectionEvaluation` snapshot + расширяет `holdoutValidation`; versioned evaluator policy выносится как явный вход. Без реконструкции из констант. §4.
- **R5b — Cycle Scorecard (потребитель):** таблица `cycle_scorecard`, pure builder, `cycle.scorecard` task + `finalizeCycle`, read-API. §5–§7.

Оба — свои plan → subagent-driven. R5b зависит от R5a. Ниже — единый дизайн; writing-plans разведёт на два.

Границы: только **cycle-scorecard** (per-hypothesis не строим — `evaluation`-строки уже есть). markdown-рендер, funnel-top (proposed/deduped), DSR/R11/R14 — вне (см. §9).

## 1. Проблема / цель

Итог цикла (что предложено/оценено, из какого пула отобран champion, насколько робастен, почему исход такой) рассеян по ledger. R5 собирает его в **один детерминированный, versioned, без-LLM артефакт** на закрытие цикла — авторитетно из ledger, **идемпотентно персистится после успешного запуска `cycle.scorecard`-task** (enqueue-gap §5.5: осиротевшая queued-строка реконсилируется P1-1 boot sweeper — уже в main #176), выпускаемый **даже без champion** (иначе rejected/drop-пространство невидимо).

## 2. Что уже персистится

- Рабочий набор = `hypothesisIds` из `hypothesis.build`-задач correlation (`listByCorrelationAndTypes(cid,['hypothesis.build'])`). Только **validated** получают build-задачу.
- `HypothesisProposal` (`findById`): `status`, `proxyMetrics`. Нет `correlationId` (funnel-top не scope'ится, §9).
- `Evaluation` (**immutable**, `evaluations.create` — единственная запись): `decision`, `metricsSnapshot`, `thresholds`, `preservationGate`. Через `listByHypothesis`→`listByBacktestRun`.
- `BacktestRun.correlationId` — есть.
- `StrategyRevision` (`findById`): `status`, `verdictReason`, `metrics` (candidate), `preservationGate`, `holdoutValidation` (сейчас только train/holdout **candidate** metrics), `hypothesisIds`, `dropped`, `comboBacktestRunId`. **Нет** baseline/thresholds/holdout-verdict → R5a их добавляет.

## 3. Таксономия счётчиков (v1)

| Счётчик | Определение |
|---|---|
| **built** | `|cycleHypothesisIds|` — validated working set |
| **evaluated** | из built — сколько имеют ≥1 завершённый `evaluation` (в этой correlation, §5.2) |
| **eligible (=N)** | `eligibleHypIds.length` — **immutable selection snapshot, переданный revision-build'ом** (не реконструкция из evaluations) |
| **considered** | `consideredHypIds.length` — capped-set после `revisionBatchMax`, тоже из revision-build |
| **selected** | `revision.status==='accepted' ? |unique(revision.hypothesisIds)| : 0` |
| **dropped** | `|{ hypId : status ∈ dropped_* } ∪ dropIds(revision.dropped)|` — **union по hypothesisId** |

`eligible`/`considered`: `number | null`. Присутствуют, когда revision-build дошёл до отбора; иначе `null` + `*UnavailableReason: 'terminated_before_selection'` (ранние терминалы вроде `no_baseline`). Провенанс исхода: `mergeAttempted`, `candidateIncluded = |unique(revision.hypothesisIds)|`. N для R7 = **eligible**.

**Три инварианта:**
1. `eligible`/`considered` — из **immutable наборов revision-build** (`eligibleHypIds` до cap, `consideredHypIds` после), НЕ реконструкция из `hypothesis.status` (мутируется) и НЕ из evaluations (evaluation могла записаться, а fail-soft status-write упасть → selection её не видел). Evaluations дают только `evaluated`/`lastDecision`.
2. `selected` — только `accepted` (у rejected candidate `hypothesisIds` тоже заполнены).
3. `dropped` — **union** по `hypothesisId` (не сумма).

## 4. R5a — Persistence decision-inputs (upstream)

### 4.1 Versioned evaluator policy
Пороги evaluator сейчас — литерал (`minTrades: 20` в revision-build) внутри `evaluateRevision` (`src/validation/revision-evaluator.ts`). R5a выносит `RevisionEvaluatorPolicy` (versioned объект: `{ evaluatorVersion, minTrades, ...пороги }`) как **явный вход** `evaluateRevision(input, policy)`; **тот же объект** сохраняется (не реконструкция из текущих констант — иначе при смене констант старые ревизии станут необъяснимы).

### 4.2 `selectionEvaluation` snapshot (аддитивное поле revision)
Один типизированный JSONB на `StrategyRevision`:
```
selectionEvaluation?: {
  evaluatorVersion: string
  baselineMetrics:  BacktestMetricBlock
  candidateMetrics: BacktestMetricBlock
  thresholds:       RevisionEvaluatorPolicy
  decision:         RevisionDecision
  reasons:          string[]
}
```
- Пишется на **окне отбора** (train для `trade_based`, full для `mode:'none'`) — то, на чём revision-build принял accept/reject.
- Пишется для accepted **и для rejected candidate** — **только если baseline/candidate comparison фактически состоялся**. Для `comparison_baseline_unavailable` (baseline-ран не получен) snapshot **невозможен** → `selectionEvaluation` отсутствует, scorecard пишет `aggregate: null` (revisionAssessment всё равно строится: status=rejected + verdictReason).
- `deltas` **не хранятся** — scorecard-builder вычисляет детерминированно из `baselineMetrics`/`candidateMetrics`.

### 4.3 Расширение `holdoutValidation` (объяснимый ROBUSTNESS)
Сейчас `{ mode, t?, reason, lowConfidence?, trainMetrics?, holdoutMetrics? }` — нет baseline и verdict. Аддитивно:
```
holdoutValidation += {
  trainBaselineMetrics?:   BacktestMetricBlock
  holdoutBaselineMetrics?: BacktestMetricBlock
  holdoutDecision?:        RevisionDecision
  holdoutReasons?:         string[]
  policy?:                 RevisionEvaluatorPolicy
}
```
(`trainMetrics`/`holdoutMetrics` остаются candidate-метриками train/holdout). Так ROBUSTNESS = полное baseline-vs-candidate сравнение на обоих окнах + verdict.

### 4.4 Хранение R5a
- `strategy_revision` + `selection_evaluation jsonb` (аддитивная nullable миграция).
- `holdout_validation` — **уже** jsonb-колонка (R3a) → расширение внутри payload, миграция колонки не нужна; меняется TS-тип + drizzle toDomain + in-memory round-trip.
- Обновить schema/domain, drizzle repo (create+toDomain+updateStatus patch), in-memory (whitelist round-trip — защита от drop полей).

## 5. R5b — Архитектура cycle-scorecard

### 5.1 Поток
```
revision-build ДОМЕННО-ТЕРМИНАЛЬНЫЙ исход (accepted / rejected / skipped / abandoned)
  → finalizeCycle(outcome)                       // ЕДИНАЯ точка; НЕ на deferred/self-requeue
      outcome = { correlationId, strategyProfileId, terminalOutcome, revisionId?,
                  eligibleHypIds?, consideredHypIds? }   // immutable selection snapshot из Step 2
    → enqueue cycle.scorecard  (FAIL-SOFT, §5.5)
       dedupeKey = `cycle.scorecard:${CYCLE_SCORECARD_SCHEMA_VERSION}:${correlationId}`

cycle.scorecard handler:
  → gather snapshot (§5.2)
  → buildCycleScorecard(snapshot)     // pure, без LLM, без clock
  → cycleScorecards.upsert(payload)    // идемпотентно по (correlationId, schemaVersion)
  → emit cycle.scorecard.built (at-least-once, §9)
  сбой gather/upsert → THROW → worker: task='failed' + BullMQ retry attempts:3 (§5.5)
```

### 5.2 Snapshot (авторитетно, scope по correlation)
- `cycleHypothesisIds` ← build-задачи correlation, unique.
- На гипотезу: `hypotheses.findById` (status для roster) + `backtests.listByHypothesis(hypId)` → **фильтр `run.correlationId === correlationId`** (listByHypothesis может вернуть исторические раны) → `evaluations.listByBacktestRun` → **последняя завершённая = детерминированный max по `(createdAt, id)`** (id-tiebreak). Даёт `evaluated` + `lastDecision`.
- `eligible`/`considered` — из `outcome.eligibleHypIds`/`consideredHypIds` (не из evaluations).
- Ревизия (если `revisionId`): `revisions.findById` → `selectionEvaluation` (AGGREGATE), `preservationGate` (TRADE-SPLIT), расширенный `holdoutValidation` (ROBUSTNESS), `status`, `verdictReason`, `hypothesisIds`, `dropped`. `revisionAssessment` строится для **accepted И rejected** (объяснимость no-champion: holdout failure / preservation veto / aggregate reject видны); `champion` = тонкий указатель, **только accepted**.

### 5.3 Терминальность (явные фиксации)
- Terminal outcomes = **{accepted, rejected, skipped, abandoned}**. `revision.build.abandoned` (исчерпание wait-cap) — **терминал**.
- **deferred/self-requeue** (`:wait${n}` re-enqueue) — **НЕ** финализирует (finalizeCycle не вызывается).
- `cycle.scorecard` **НЕ в `CYCLE_CHAIN_TYPES`** (`['hypothesis.build','backtest.completed','research.run_cycle']`, cycle-close.ts:6) — иначе вмешается в R1 terminality-gate.

### 5.4 Payload (детерминированный, без LLM)
```
CycleScorecard {
  schemaVersion: 'cycle-scorecard-v1'
  correlationId, strategyProfileId
  terminalOutcome: { kind: 'accepted'|'rejected'|'skipped'|'abandoned', reason }
  counts: { built, evaluated, eligible, considered, selected, dropped }
  eligibleUnavailableReason?, consideredUnavailableReason?: string
  provenance: { mergeAttempted, candidateIncluded, revisionId?, sourceTaskId }
  revisionAssessment: null | {                // для accepted И rejected — объясняет любой исход
    revisionId, version,
    status: 'accepted' | 'rejected',
    aggregate:  null | { evaluatorVersion, baselineMetrics, candidateMetrics, deltas, thresholds, decision, reasons }
                //  из selectionEvaluation; null если comparison не состоялся (comparison_baseline_unavailable, §4.2).
                //  deltas ВЫЧИСЛЯЮТСЯ builder'ом из baseline/candidate
    tradeSplit: preservationGate | null       // §TRADE-SPLIT (R2 veto виден и для rejected)
    robustness: holdoutValidation | null      // §ROBUSTNESS: holdout failure виден и для rejected (train+holdout baseline+candidate+verdict)
  }
  champion: null | { revisionId, version }    // ТОЛЬКО accepted (тонкий указатель; детали — в revisionAssessment)
  selectionBias: { n: eligible, considered, selected }
  roster: [ { hypId, lastDecision, terminalStatus, considered } ]   // тонкий; ссылки, не метрики
  verdict: { decision, reason }               // детерминированный
}
```
`generatedAt` — **вне payload** (metadata-колонка строки, §5.6).

### 5.5 Ошибки / enqueue-gap / дедлеттер (правка 2)
**Generic dead-letter hook отсутствует.** worker.ts на throw ставит task `'failed'` + re-throw; BullMQ `attempts:3` + `removeOnFail:5000` — лишь удержание failed-job, **не** финальное событие и **не** hook (worker не знает `attemptsMade/maxAttempts`). Поэтому:
- Handler на сбое gather/upsert **бросает** → task `'failed'` + BullMQ retry (attempts:3) → при исчерпании job остаётся в failed-set (наблюдаемость = failed job + task.status, **НЕ** событие). Спека **не обещает** `cycle.scorecard.failed`.
- **Enqueue-gap (P1-1 ЗАКРЫТ в main, #176).** `finalizeCycle` создаёт cycle.scorecard-row через **`createAndEnqueueTask`** (DB-row status `'queued'`, затем enqueue). Если enqueue падает после row-create, осиротевшую `queued`-строку подберёт **P1-1 boot sweeper** (`reconcileQueuedTasks`, `src/orchestrator/reconcile-queued-tasks.ts` — generic: переэнкьюит КАЖДУЮ `queued`-строку всех task types на рестарте воркера, дедуп по jobId). Так scorecard-row реконсилируется eventual-ly, не теряется навсегда. `finalizeCycle`-enqueue всё равно **FAIL-SOFT из revision-build** (сбой → `cycle.scorecard_enqueue_failed` event, НЕ бросает — чтобы не переиграть доменное решение ревизии на ретрае). Между сбоем enqueue и рестартом воркера scorecard просто отсутствует (P1-1 закрывает окно на boot). Требование к дизайну: finalizeCycle обязан идти через `createAndEnqueueTask` (не голый `queue.enqueue`), иначе P1-1 её не увидит (`listQueued`).
- Инвариант: сбой scorecard **ретраится независимо и не переигрывает ревизию**; финальный failed-job оставляет цикл завершённым; осиротевшая enqueue-row реконсилируется P1-1 на рестарте.

### 5.6 Хранение R5b + идемпотентность
Таблица `cycle_scorecard`: `id`, `correlationId`, `strategyProfileId`, `schemaVersion`, **`payload jsonb`**, `generatedAt` (metadata-колонка, НЕ в payload — payload идентичен при повторной сборке), `createdAt`, `updatedAt`; **`UNIQUE(correlationId, schemaVersion)`** → идемпотентный upsert (физически at-least-once, логически exactly-once). Port `CycleScorecardRepository { upsert, findByCorrelation }` + drizzle + in-memory (round-trip). read-API route: `GET` по `correlationId`.

## 6. dedupeKey (правка 1)
`cycle.scorecard:${CYCLE_SCORECARD_SCHEMA_VERSION}:${correlationId}` — schemaVersion **в ключе**, иначе v2 не построится из-за существующей v1-задачи.

## 7. Тестирование
**R5a:** versioned policy как явный вход + сохранён тот же объект (не константа); `selectionEvaluation` пишется на accepted И rejected; holdout-расширение (baseline+verdict) round-trip (drizzle+in-memory, whitelist-drop RED); миграция `selection_evaluation`.
**R5b:**
- Pure builder по-веточно: accepted (champion={revisionId,version}, revisionAssessment.aggregate deltas вычислены из baseline/candidate) / **rejected → champion=null, но revisionAssessment несёт aggregate/tradeSplit/robustness (holdout failure / preservation veto видны), selected=0** / rejected с `comparison_baseline_unavailable` → revisionAssessment.aggregate=null / skipped / abandoned / dropped union-дедуп / eligible+considered из наборов vs null+reason.
- Snapshot: evaluation scope по correlation (ран другой correlation игнорируется); max по (createdAt,id) при tie.
- Handler: upsert-идемпотентность (двойной прогон = 1 строка, идентичный payload); throw на gather-сбое (проброс, НЕ self-dead-letter).
- finalizeCycle: энкьюит на 4 терминалах; НЕ на deferred; **fail-soft** enqueue → `cycle.scorecard_enqueue_failed` (не бросает из revision-build); dedupeKey с schemaVersion.
- Гард: `cycle.scorecard` не в `CYCLE_CHAIN_TYPES`.
- Persistence round-trip + read-API.

## 8. Инварианты / gotchas
- **R5a consumer-контракты (из финального R5a-review, сверено 2026-07-14 с фактическими типами в main).** Scorecard-builder ОБЯЗАН терпеть:
  - `revisionAssessment.aggregate = null`, когда `revision.selectionEvaluation` отсутствует — это не только `comparison_baseline_unavailable`, но и **любая rejected-строка, чей ФИНАЛЬНЫЙ greedy-attempt не дал comparison** (напр. attempt-1 evaluated REJECT, attempt-2 `candidate_run_unavailable`; snapshot сбрасывается per-итерацию → на терминале undefined). Не путать с «оценки не было вовсе».
  - `kind:'consolidated'` строки **не несут** `selectionEvaluation` (G3b-путь использует `evaluateConsolidation`, не `evaluateRevision`) → `aggregate = null` для них ожидаемо; `robustness`/`tradeSplit` тоже могут отсутствовать.
  - **Multi-attempt семантика полей различна** (задокументировано in-code на rejected-persist site): на multi-attempt greedy-build `verdictReason` = все attempts, `preservationGate` = sticky-LAST fired veto (`firedPreservation` не сбрасывается per-итерацию), `selectionEvaluation` = ФИНАЛЬНЫЙ attempt. Scorecard **не должен** читать `tradeSplit` (preservationGate) и `aggregate` (selectionEvaluation) как описывающие один attempt — они могут быть из разных. Выравнивание `firedPreservation` = поведенческое изменение, отложено (если понадобится строгая пара — отдельный слайс, не R5b по умолчанию).
- `eligible`/`considered`/N — из immutable наборов revision-build, не из status и не из evaluations.
- `selected` — только accepted; `dropped` — union по hypothesisId.
- `selectionEvaluation`/holdout — **сохранённые входы** оценки (versioned policy), не реконструкция из констант; пишутся и для rejected.
- `deltas` builder считает из сохранённых metrics (не хранятся).
- dedupeKey несёт schemaVersion; `cycle.scorecard` вне `CYCLE_CHAIN_TYPES`; abandoned=терминал; deferred≠терминал; `generatedAt` вне payload.
- `finalizeCycle`-enqueue fail-soft (enqueue-gap + row-then-enqueue → нельзя безоговорочно ретраить ревизию); осиротевшая enqueue-row реконсилируется P1-1 boot sweeper (в main #176); finalizeCycle через createAndEnqueueTask.
- Нет generic dead-letter hook → спека не обещает финальное failed-событие; наблюдаемость = failed task/job.
- `cycle.scorecard.built` — **at-least-once** (upsert прошёл, append события упал → retry повторит событие): потребители обязаны быть толерантны/идемпотентны (документировано; дедуп события — вне v1).

## 9. Границы / отложено
- **markdown-рендер** — отдельный слайс; v1 = pure jsonb → рендер = чистая функция поверх payload.
- **Funnel-top** (proposed/deduped/rejected-на-валидации) — требует upstream `correlationId` на `hypothesis_proposal`; follow-up. R7 (N=eligible) покрыт без него.
- **DSR** advisory — consume из backtester E2, не строим. **R11** bootstrap-CI, **R14** regime — later.
- Enqueue reconciliation закрыт P1-1 boot sweeper (в main #176) — finalizeCycle создаёт row через createAndEnqueueTask, осиротевшие queued-строки переэнкьюиваются на рестарте воркера.
