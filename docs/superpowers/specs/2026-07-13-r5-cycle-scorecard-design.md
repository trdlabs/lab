# R5 — Cycle Scorecard (детерминированный versioned артефакт закрытого цикла)

**Дата:** 2026-07-13
**Статус:** design approved (brainstorming), ready for writing-plans
**Источник:** hypothesis-eval review `docs/research/2026-07-11-hypothesis-evaluation-workflow-review.md` §R5 (+§R7 selection-bias). Первый слайс после R1/R2/R3a/R3b-1/R4 (все в main).

## 1. Проблема / цель

Итог цикла (что предложено, что оценено, из какого пула отобран champion, насколько он робастен, почему исход именно такой) сегодня рассеян по ledger-строкам и событиям. R5 собирает его в **один детерминированный, versioned, без-LLM артефакт** на закрытие цикла — авторитетно из ledger, exactly-once, выпускаемый **даже без champion** (иначе rejected/drop-пространство невидимо).

Границы v1: только **cycle-scorecard** (per-hypothesis scorecard не строим — `evaluation`-строки уже есть). markdown-рендер, funnel-top (proposed/deduped), DSR/R11/R14 — вне слайса (см. §8).

## 2. Что уже персистится (авторитетные источники)

- Рабочий набор цикла = `hypothesisIds` из `hypothesis.build`-задач correlation (`listByCorrelationAndTypes(cid, ['hypothesis.build'])`, паттерн revision-build:210). Только **validated**-гипотезы получают build-задачу.
- `HypothesisProposal` (`findById`): `status`, `proxyMetrics` (нет `correlationId` — поэтому funnel-top не scope'ится, §8).
- `Evaluation` (**immutable**, `evaluations.create` — единственная запись): `decision`, `reasons`, `metricsSnapshot` (baseline+variant), `thresholds`, `preservationGate` (R2). Достаётся `listByHypothesis`→`listByBacktestRun`.
- `BacktestRun.correlationId` — есть (нужен для scope evaluations, §4.2).
- `StrategyRevision` (`findById`): `status`, `verdictReason`, `metrics`, `holdoutValidation` (R3a), `preservationGate` (R2), `hypothesisIds`, `dropped: DroppedHypothesis[]`.

## 3. Таксономия счётчиков (v1, авторитетно из строк)

| Счётчик | Определение |
|---|---|
| **built** | `|cycleHypothesisIds|` — validated working set |
| **evaluated** | из built — сколько имеют ≥1 завершённый `evaluation` (в этой correlation, §4.2) |
| **eligible (=N)** | `|{ hypId : last-completed evaluation.decision ∈ {PASS, PAPER_CANDIDATE} }|` — из **immutable evaluation-строк**, НЕ из `hypothesis.status` (revision-build мутирует его в merged/dropped) |
| **considered** | `number \| null` — размер capped selection-пула, реально вошедшего в merge; передаётся revision-build'ом (§4.3). `null` + `consideredUnavailableReason`, когда терминал наступил до отбора |
| **selected** | `revision.status==='accepted' ? |unique(revision.hypothesisIds)| : 0` |
| **dropped** | `|{ hypId : status ∈ dropped_* } ∪ dropIds(revision.dropped)|` — **union по hypothesisId**, не сумма |

Провенанс исхода: `mergeAttempted` (revision-row существует и не skipped), `candidateIncluded = |unique(revision.hypothesisIds)|` (даже для rejected — видимость no-champion drop-пространства). N для R7 = **eligible** (immutable). Funnel чисто вложен: built ⊇ evaluated ⊇ eligible ⊇ considered ⊇ selected.

**Три инварианта таксономии (иначе баги):**
1. `eligible` — из **последней завершённой evaluation** каждой гипотезы, не из финального `hypothesis.status` (мутируется revision-build'ом до async-scorecard). evaluation-строки immutable → это и есть selection snapshot.
2. `selected` считается **только для `accepted`** ревизии (`revision.hypothesisIds` существует и у rejected candidate).
3. `dropped` — **union** множеств `{dropped_* status}` и `{revision.dropped}` по `hypothesisId` (не сумма — иначе одна гипотеза задвоится).

## 4. Архитектура

### 4.1 Поток
```
revision-build ДОМЕННО-ТЕРМИНАЛЬНЫЙ исход (accepted / rejected / skipped / abandoned)
  → finalizeCycle(outcome)                                  // ЕДИНАЯ точка; НЕ на deferred/self-requeue
    → enqueue cycle.scorecard
       dedupeKey = `cycle.scorecard:${CYCLE_SCORECARD_SCHEMA_VERSION}:${correlationId}`   // logical exactly-once
       payload   = { correlationId, strategyProfileId, terminalOutcome, revisionId?, consideredHypIds? }

cycle.scorecard handler:
  → gather snapshot (§4.2, authoritative rows)
  → buildCycleScorecard(snapshot)          // pure, без LLM, без clock
  → cycleScorecards.upsert(payload)         // идемпотентно по (correlationId, schemaVersion)
  → emit cycle.scorecard.built
  сбой gather/upsert → THROW → общий worker retry (BullMQ attempts:3 + backoff) → dead-letter (§4.5)
```

### 4.2 Snapshot (авторитетно, scope по correlation)
- `cycleHypothesisIds` ← `listByCorrelationAndTypes(cid, ['hypothesis.build'])`.map(payload.hypothesisId), unique.
- На гипотезу: `hypotheses.findById` (status) + `backtests.listByHypothesis(hypId)` → **фильтр `run.correlationId === correlationId`** (listByHypothesis может вернуть исторические раны) → на каждый run `evaluations.listByBacktestRun` → **последняя завершённая evaluation = детерминированный max по `(createdAt, id)`** (id-tiebreak исключает недетерминизм при равном createdAt).
- Ревизия (если `revisionId`): `revisions.findById` → terminal-поля.
- Counts по §3.

### 4.3 `considered` — из revision-build, не реконструкция
`considered` НЕ всегда выводим из revision-строки: для `nothing_composable` / ранних skipped / отсутствующей строки `included ∪ dropped` недоступен, хотя отбор мог состояться → нельзя писать ложный 0. Поэтому revision-build **передаёт в `finalizeCycle` immutable `consideredHypIds`** — capped selection-пул `sortEligible(proposals).slice(0, revisionBatchMax)`, известный до compose. Builder:
- `consideredHypIds` присутствует → `considered = consideredHypIds.length`; помечает roster-записи флагом `considered`.
- отсутствует (терминал до отбора, напр. `no_baseline`) → `considered = null`, `consideredUnavailableReason = 'terminated_before_selection'`.

### 4.4 Терминальность (явные фиксации)
- Terminal outcomes = **{accepted, rejected, skipped, abandoned}**. `revision.build.abandoned` (исчерпание wait-cap) — **терминал** (иначе цикл не получит scorecard).
- **deferred / self-requeue** (`:wait${n}` re-enqueue) — **НЕ** финализирует цикл (finalizeCycle не вызывается).
- `cycle.scorecard` **НЕ добавляется в `CYCLE_CHAIN_TYPES`** (`['hypothesis.build','backtest.completed','research.run_cycle']`, cycle-close.ts:6) — иначе вмешается в R1 terminality-gate (`isCycleChainTerminal`).

### 4.5 Ошибки / дедлеттер (правка 4)
Handler на сбое сбора/записи **бросает** — маршрутизируется через **существующий** worker-контур (BullMQ `attempts:3` + exponential backoff → failed-queue dead-letter; прецедент `paper-start.handler`). Handler **не** детектирует «последний retry» и **не** эмитит own dead-letter — это принадлежит generic worker/dead-letter hook (у него есть attempt/maxAttempts). Инвариант: сбой scorecard **ретраится независимо и не переигрывает решение ревизии**; цикл остаётся завершённым при финальном dead-letter.

### 4.6 Идемпотентность
`upsert` по unique `(correlationId, schemaVersion)` перезаписывает тем же детерминированным payload. Физически at-least-once, логически exactly-once.

## 5. Хранение

Новая таблица `cycle_scorecard`:
- `id`, `correlationId`, `strategyProfileId`, `schemaVersion`, **`payload jsonb`** (детерминированный), `generatedAt` (**metadata-колонка строки, НЕ внутри payload** — payload остаётся идентичным при повторной сборке), `createdAt`, `updatedAt`.
- `UNIQUE(correlationId, schemaVersion)` → идемпотентный upsert.
- Port `CycleScorecardRepository { upsert(row), findByCorrelation(cid): CycleScorecard[] }` + drizzle + in-memory (round-trip тест).
- read-API route: `GET` scorecard по `correlationId`.

## 6. Payload (детерминированный, без LLM)
```
CycleScorecard {
  schemaVersion: 'cycle-scorecard-v1'
  correlationId, strategyProfileId
  terminalOutcome: { kind: 'accepted'|'rejected'|'skipped'|'abandoned', reason }
  counts: { built, evaluated, eligible, considered, selected, dropped }
  consideredUnavailableReason?: string
  provenance: { mergeAttempted, candidateIncluded, revisionId?, sourceTaskId }
  champion: null | {                          // только при accepted
    revisionId, version,
    aggregate:  { metrics, baselineMetrics, deltas, thresholds, decision }   // §AGGREGATE (ladder)
    tradeSplit: preservationGate | null        // §TRADE-LEVEL SPLIT (R2)
    robustness: holdoutValidation | null       // §ROBUSTNESS (R3a train/holdout + lowConfidence)
  }
  selectionBias: { n: eligible, considered, selected }      // §R7
  roster: [ { hypId, lastDecision, terminalStatus, considered } ]   // тонкий, ссылки не метрики (не дублирует evaluation rows)
  verdict: { decision, reason }               // детерминированный (champion / reject-reason / skip-reason)
}
```
`generatedAt` — вне payload (§5).

## 7. Тестирование
- **Pure builder** (`buildCycleScorecard`, по-веточно): accepted champion (все секции) / rejected → selected=0, champion=null / skipped-no-champion / abandoned / eligible из evaluation-decision, НЕ из мутированного status / dropped union-дедуп (гипотеза в обоих источниках = 1) / considered из `consideredHypIds` vs null+reason.
- **Snapshot gather**: evaluation scope по correlation (исторический ран другой correlation игнорируется); детерминированный max по (createdAt,id) при tie.
- **Handler**: upsert-идемпотентность (двойной прогон = одна строка, идентичный payload); throw на gather-сбое (маршрут в worker retry — тест на проброс, не на self-dead-letter).
- **finalizeCycle**: энкьюит на всех 4 терминалах; НЕ энкьюит на deferred/self-requeue; dedupeKey с schemaVersion.
- **Persistence** round-trip (in-memory + drizzle, UNIQUE-конфликт → upsert).
- **read-API** route.
- **Гард**: тест, что `cycle.scorecard` не в `CYCLE_CHAIN_TYPES`.

## 8. Границы / отложено
- **markdown-рендер** (office/chat completion-summary) — отдельный слайс; v1 = pure jsonb → рендер = чистая функция поверх готового payload.
- **Funnel-top** (proposed/deduped/rejected-на-валидации) — требует upstream `correlationId` на `hypothesis_proposal` (иначе недосчёт pre-validation дропов → нарушение no-shortcuts). Follow-up; R7 headline (N=eligible) покрыт без него.
- **DSR** advisory-поле — consume из backtester E2, не строим.
- **R11** bootstrap-CI, **R14** regime breakdown — later.

## 9. Инварианты / gotchas
- `eligible`/N — из immutable evaluations, не из мутируемого status.
- `selected` — только accepted; `considered` — из revision-build snapshot, не post-hoc из строки (иначе ложный 0).
- `dropped` — union по hypothesisId.
- dedupeKey несёт schemaVersion (иначе v2 заблокирован существующей v1-задачей).
- `cycle.scorecard` вне `CYCLE_CHAIN_TYPES`; abandoned = терминал; deferred = не терминал; `generatedAt` — вне payload.
- Builder чистый (без clock/LLM); handler throw'ит, dead-letter — общий worker-контур.
- Без миграции данных — только аддитивная таблица.
