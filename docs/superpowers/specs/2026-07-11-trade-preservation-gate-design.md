# Trade-Level Preservation Gate (R2) — Design Spec

**Дата:** 2026-07-11
**Родительский отчёт:** `docs/research/2026-07-11-hypothesis-evaluation-workflow-review.md` (рекомендация **R2**, приоритет P0).
**Scope:** ТОЛЬКО R2. R1 (замкнуть петлю), R3 (OOS-дисциплина), R4 (feedback/minute/decision-log) — отдельные слайсы, не здесь.
**Кросс-репо:** нет. Изменения только в `lab`.

---

## 1. Цель и мотивация

Приёмка гипотез/ревизий сегодня — только по агрегатам (`evaluateBacktest`, `evaluateRevision`). Это позволяет гипотезе «улучшить» net PnL нечестно: обрезав хорошие сделки, отказавшись от сделок вообще (abstention gaming), или раздув PnL незакрытой end-of-data позицией. Первый живой прогон Цикла 1 показал именно abstention/end_of_data эксплойт (7 tp/hard_stop сделок → 1 позиция `end_of_data`).

R2 добавляет **детерминированный veto-слой**, который сравнивает трейды baseline-рана и variant-рана и **понижает** would-accept вердикт, если гипотеза убила хорошие сделки, сыграла на отказе от сделок, или получила «улучшение» за счёт незакрытой позиции. Слой **никогда не повышает** вердикт.

**Инварианты (соблюсти):**
- Приёмка остаётся детерминированной; LLM не участвует.
- `evaluateBacktest` / `evaluateRevision` остаются чистыми на агрегатах — их сигнатуры НЕ меняются. Veto — отдельная композиция поверх.
- Veto только понижает: `PASS`/`PAPER_CANDIDATE` → `MODIFY`/`INCONCLUSIVE`; `ACCEPT` → `REJECT`. Would-fail вердикты не трогает.
- Используем **реальный** `closeReason` от движка (включая `end_of_data`), не эвристику по концу окна.

---

## 2. Секция A — Расширение модели данных (перестать терять `closeReason`)

Движок бэктестера уже сериализует `closeReason` (включая first-class `'end_of_data'`, `apps/backtester/src/engine/artifacts.ts::CloseReason`) в строки trades-артефакта; `readArtifact` отдаёт строки сырыми и SDK-схема их не срезает. lab теряет поле в одном месте — `parseTrade` не читает `r.closeReason`.

**Изменения:**
1. `src/domain/research-experiment.ts::TradeRecord` — добавить `closeReason?: string`.
   Комментарий: сырой движковый reason as-is (`'end_of_data' | 'stop_hit' | 'take_hit' | 'time_exit' | 'strategy_exit' | ...`), НЕ нормализованный. Опционально, т.к. fake/legacy-фикстуры могут не задавать.
2. `src/adapters/platform/http-backtester.adapter.ts::parseTrade` — читать `r.closeReason`: `closeReason: typeof r.closeReason === 'string' ? r.closeReason : undefined`.
3. Fake/mock run-trades адаптеры (`fake-run-trades.adapter.ts`, `mock-run-trades.adapter.ts`) — их `TradeRecord` фикстуры принимают `closeReason` (тип уже расширен, менять код не обязательно; проверить, что не ломается тайпчек).

**Инвариант:** ни один существующий вызов не должен зависеть от отсутствия поля. Поле аддитивное, опциональное.

---

## 3. Секция B — Модуль `evaluateTradePreservation` (чистая функция)

Новый файл: `src/validation/trade-preservation.ts`.

### 3.1 Сигнатура

```
export type PreservationReason = 'end_of_data_position' | 'abstention_gaming' | 'winner_degradation';

export interface PreservationThresholds {
  winnerRetention: number;   // 0.9   — доля baseline winner-gross, которую variant обязан сохранить
  maxTradeDropPct: number;   // 20    — падение числа сделок (%), выше которого проверяется abstention
  abstentionShare: number;   // 0.7   — доля ΔnetPnl, объяснённая исчезнувшими лузерами, для veto
  eodShare: number;          // 0.5   — доля ΔnetPnl, объяснённая end_of_data variant-трейдами, для veto
  matchToleranceMs: number;  // 0     — допуск матчинга по entryTs (0 = тот же бар)
  minWinnerSample: number;   // 3     — минимум baseline winners, ниже — winner_degradation пропускается
}

export interface PreservationMetadata {
  fired: boolean;
  reason: PreservationReason | null;
  metrics: {
    totalDelta: number;
    matchedCount: number;
    disappearedCount: number;
    newCount: number;
    baselineWinnerCount: number;
    eodDelta?: number;
    dropPct?: number;
    removedLosersPnl?: number;
    baselineWinnerGross?: number;
    variantWinnerContribution?: number;
  };
  thresholds: PreservationThresholds;
}

// Минимальный агрегатный вход — обе линии его отдают без натяжки.
// Линия гипотез: baseline/variant из ComparisonSummary.
// Линия ревизий: accepted → baseline, candidate → variant.
export interface PreservationAggregates {
  baseline: { netPnlUsd: number; totalTrades: number };
  variant: { netPnlUsd: number; totalTrades: number };
}

export function evaluateTradePreservation(
  baselineTrades: TradeRecord[],
  variantTrades: TradeRecord[],
  agg: PreservationAggregates,
  t: PreservationThresholds,
): PreservationMetadata;
```

`totalDelta = agg.variant.netPnlUsd - agg.baseline.netPnlUsd`. Каждый call-site конструирует `PreservationAggregates` из своих метрик-блоков (гипотезы — из `ComparisonSummary`; ревизии — accepted как baseline, candidate как variant).

### 3.2 Матчинг (детерминированный, greedy nearest)

- Разбить оба массива по `side` (`long` / `short`). Матчинг только внутри одного side.
- **Детерминированная сортировка** каждого массива перед матчингом: по `entryTs` asc, затем `exitTs` asc, затем `realizedPnl` asc, затем исходный индекс asc. (Устраняет флап при pyramiding / нескольких сделках на одном баре.)
- Greedy: для каждого baseline-трейда (в отсортированном порядке) найти ближайший **неспаренный** variant-трейд того же side с `|entryTs_b − entryTs_v| ≤ matchToleranceMs`; при равном расстоянии — первый в отсортированном порядке variant. Спарить оба.
- Результат: `matchedPairs[{ baseline, variant }]`, `disappearedBaseline[]` (baseline без пары), `newVariant[]` (variant без пары).
- Примечание: это greedy-детерминированный матчинг, НЕ оптимальный bipartite. Достаточно для слайса; при `matchToleranceMs=0` спариваются только точные совпадения по entryTs.

### 3.3 Кластеры baseline

- `winners = baselineTrades.filter(realizedPnl > 0)`
- `losers  = baselineTrades.filter(realizedPnl < 0)`
- neutral (`== 0`) — не участвует в вердиктах.

### 3.4 Вердикты (проверяются в этом порядке; первый сработавший — результат)

Все считаются, только если гейт вызван (см. §5 — только на would-accept вердиктах).

**(1) `end_of_data_position` → INCONCLUSIVE.**
Артефакт данных/окна: «улучшение» держится на незакрытой позиции. Ретрай не поможет → INCONCLUSIVE (существующий флоу INCONCLUSIVE не ретраится).
```
if (totalDelta <= 0) → не срабатывает.
eodDelta =
    Σ  over matchedPairs where variant.closeReason === 'end_of_data'
         of max(0, variant.realizedPnl − matchedBaseline.realizedPnl)
  + Σ  over newVariant   where closeReason        === 'end_of_data'
         of max(0, variant.realizedPnl)
veto if  eodDelta >= eodShare * totalDelta
```
Инкрементальная атрибуция: если baseline-трейд тоже был `end_of_data`, его PnL вычитается через matched baseline и НЕ считается бесплатным gain. `max(0, ·)` per-trade — EOD-трейды, которые навредили, не входят в «улучшение».

**(2) `abstention_gaming` → MODIFY.**
Может быть настоящей идеей стратегии (меньше входов), но улучшение через отказ от сделок требует переформулировки/доказательства → MODIFY (ретраится), не INCONCLUSIVE.
```
if (summary.baseline.totalTrades <= 0) → не срабатывает.
dropPct = (baseline.totalTrades − variant.totalTrades) / baseline.totalTrades * 100
if (dropPct < maxTradeDropPct) → не срабатывает.
if (totalDelta <= 0) → не срабатывает (агрегат уже бы FAIL).
removedLosersPnl = Σ over disappearedBaseline where realizedPnl < 0 of |realizedPnl|
veto if  removedLosersPnl >= abstentionShare * totalDelta
```

**(3) `winner_degradation` → MODIFY.**
Хорошие сделки обрезаны.
```
if (winners.length < minWinnerSample) → не срабатывает (guard от шума).
baselineWinnerGross     = Σ realizedPnl of winners            // > 0
variantWinnerContribution =
    Σ over winners of (matched variant.realizedPnl if matched else 0)
  // disappeared winner → вклад 0; matched winner, ставший убыточным → его ФАКТИЧЕСКИЙ variant.realizedPnl (может быть < 0), НЕ обрезается до 0.
veto if  variantWinnerContribution < winnerRetention * baselineWinnerGross
```

Если ни один не сработал → `fired: false, reason: null`, метрики заполнены для наблюдаемости.

---

## 4. Секция C — Композиция (veto только вниз) + structured metadata

Новый общий helper: `src/validation/apply-preservation-gate.ts` (или экспорт рядом с модулем).

```
applyPreservationGate(outcome, baselineTrades, variantTrades, agg, thresholds)
  → { outcome: EvaluationOutcome (возможно понижен), preservation: PreservationMetadata }
// agg: PreservationAggregates (§3.1)
```

**Правило композиции (явное):**
- Гейт применяется ТОЛЬКО когда исходный вердикт would-accept:
  - линия гипотез: `PASS` или `PAPER_CANDIDATE`;
  - линия ревизий: `ACCEPT`.
- Если исходный вердикт НЕ would-accept (`FAIL`/`MODIFY`/`INCONCLUSIVE`/`REJECT`) — гейт НЕ вызывается, трейды НЕ фетчатся (экономия), `preservation` отсутствует/`fired:false`.
- Если veto сработал:
  - линия гипотез: `end_of_data_position` → `INCONCLUSIVE`; `abstention_gaming`/`winner_degradation` → `MODIFY`. Reason добавляется в `reasons`.
  - линия ревизий: любой veto → `REJECT` с preservation-причиной.
- Veto **только понижает**. Никогда не повышает и не трогает would-fail.

**Structured metadata (не только строка):** `PreservationMetadata` персистится:
- линия гипотез — в jsonb `Evaluation`-строки (рядом с `decision`/`reasons`/`thresholds`), поле `preservationGate`.
- линия ревизий — в `strategy_revision` eval-метаданных (рядом с `verdictReason`).
Это питает R4 (feedback) и R5 (scorecard) + объяснимость в UI/логах.

**Проводка (call-sites):**
- **MUST** — линия гипотез, proxy-путь: `src/orchestrator/handlers/backtest-support.ts::finalizeBacktestCompletion` (место, где `ComparisonSummary` → `evaluateBacktest` → persist `Evaluation`). Здесь живёт Цикл-2 retry-путь, где и был эксплойт.
- **MUST** — линия ревизий: `src/orchestrator/handlers/revision-build.handler.ts` (место вызова `evaluateRevision`, ~324; combo baseline vs variant).
- **SHOULD** — experiment/holdout путь: `src/validation/experiment-evaluator.ts::evaluateExperiment`, если он эмитит `PASS`/`PAPER_CANDIDATE` и runId'ы train/holdout ранов + их трейды доступны в том же контексте. Тот же helper. Если проводка нетривиальна — вынести follow-up'ом (зафиксировать в PR body), но НЕ молча пропустить.
- Оба MUST-хэндлера уже держат baseline+variant runId. Добавить зависимость `runTrades: RunTradesPort` в их DI (через `app-services.ts`), фетчить `getRunTrades(baselineRunId)` + `getRunTrades(variantRunId)` только когда гейт применяется.

---

## 5. Секция D — Конфиг и kill-switch

Единый источник порогов — расширить существующий `evaluatorThresholds`-механизм (`src/config/env.ts`), не плодить параллельный.

| Env | Default | Назначение |
|---|---|---|
| `LAB_TRADE_PRESERVATION_GATE` | `on` | `off` = полный откат к старому evaluator-вердикту |
| `LAB_TRADE_PRESERVATION_WINNER_RETENTION` | `0.9` | доля сохранения winner-gross |
| `LAB_TRADE_PRESERVATION_MAX_TRADE_DROP_PCT` | `20` | порог падения числа сделок |
| `LAB_TRADE_PRESERVATION_ABSTENTION_SHARE` | `0.7` | доля ΔnetPnl от исчезнувших лузеров |
| `LAB_TRADE_PRESERVATION_EOD_SHARE` | `0.5` | доля ΔnetPnl от end_of_data variant-трейдов |
| `LAB_TRADE_PRESERVATION_MATCH_TOLERANCE_MS` | `0` | допуск матчинга по entryTs |
| `LAB_TRADE_PRESERVATION_MIN_WINNER_SAMPLE` | `3` | guard winner_degradation |

**Kill-switch `off`:** short-circuit **до** `getRunTrades` — при `off` трейды для preservation не фетчатся вовсе, оба пайплайна возвращают исходный evaluator-вердикт без изменений и без `preservationGate`.

---

## 6. Секция E — Тестирование (TDD)

Порядок: тесты пишутся до реализации каждого юнита.

**Юнит `evaluateTradePreservation`:**
1. Матчинг: survive (точный entryTs) / disappear / new; tie-break при нескольких сделках на одном баре — детерминированный порядок, отсутствие флапа.
2. `end_of_data_position`: variant EOD-трейд даёт ≥ eodShare ΔnetPnl → fired INCONCLUSIVE; baseline тоже EOD → инкрементальная атрибуция не засчитывает как gain; `totalDelta<=0` → не срабатывает.
3. `abstention_gaming`: drop ≥ порога + removedLosers объясняют ≥ abstentionShare → fired MODIFY; drop есть, но объяснение < share → не срабатывает.
4. `winner_degradation`: disappeared winner (вклад 0) → degradation; matched-turned-loser учитывается фактическим отрицательным PnL; winners < minWinnerSample → guard, не срабатывает.
5. Ни один не сработал → `fired:false`, метрики заполнены.

**Регресс-якорь (обязательный):** воспроизвести Цикл-1 эксплойт — гипотеза убирает все сделки кроме одной `end_of_data` → итоговый вердикт INCONCLUSIVE, НЕ PASS.

**Композиция:**
6. veto только понижает: would-fail вердикт (FAIL/MODIFY/INCONCLUSIVE) veto не трогает и трейды не фетчит.
7. `PASS` + veto → понижен; `PAPER_CANDIDATE` + veto → понижен; `preservationGate` metadata сохранён.

**Интеграция обеих линий:**
8. Линия гипотез: `finalizeBacktestCompletion` понижает PASS→MODIFY/INCONCLUSIVE, `Evaluation.preservationGate` персистится.
9. Линия ревизий: combo ACCEPT + veto → REJECT с preservation-причиной.

**Kill-switch:**
10. `LAB_TRADE_PRESERVATION_GATE=off`: оба пайплайна возвращают старый вердикт; `getRunTrades` для preservation НЕ вызывается (assert на мок).

**Регрессия существующих тестов:** обновить тесты `evaluator` / `revision-evaluator` / `backtest-support` / `revision-build` под новую композицию (там, где раньше ожидался PASS/ACCEPT на входах, которые теперь ловит veto — либо скорректировать фикстуры, либо явно выставить `GATE=off`).

---

## 7. Файлы, которых касаемся

- `src/domain/research-experiment.ts` — `TradeRecord.closeReason?`
- `src/adapters/platform/http-backtester.adapter.ts` — `parseTrade`
- `src/validation/trade-preservation.ts` — **new** (модуль + типы)
- `src/validation/apply-preservation-gate.ts` — **new** (композиция, downgrade-only)
- `src/orchestrator/handlers/backtest-support.ts` — проводка (линия гипотез)
- `src/orchestrator/handlers/revision-build.handler.ts` — проводка (линия ревизий)
- `src/orchestrator/app-services.ts` — DI `runTrades` в оба хэндлера
- `src/config/env.ts` — 7 env-порогов + kill-switch
- (SHOULD) `src/validation/experiment-evaluator.ts` — тот же helper на holdout-пути
- тесты рядом с каждым

---

## 8. Вне scope (явно)

- R1 (замкнуть петлю accepted-ревизия → paper), R3 (OOS-дисциплина Цикла 2), R4 (feedback/minute/decision-log в промпт) — отдельные слайсы.
- Multi-symbol матчинг (сейчас раны single-symbol; `TradeRecord` не несёт `symbol`). Если понадобится — расширить `TradeRecord.symbol` отдельным слайсом.
- Оптимальный bipartite-матчинг (сейчас greedy-детерминированный).
- Нормализация `closeReason` в канон (используем сырой движковый; `end_of_data` матчим по литералу).
- DSR/PBO (см. R13 отчёта — стадийно, при ≥60 днях истории).

---

## 9. Критерии приёмки

1. Регресс-якорь (§6, EOD-abstention сценарий) даёт INCONCLUSIVE.
2. Veto срабатывает на обеих линиях и только понижает; `preservationGate` metadata персистится (jsonb) на обеих.
3. `LAB_TRADE_PRESERVATION_GATE=off` полностью восстанавливает старое поведение без фетча трейдов.
4. `closeReason` доходит из артефакта в `TradeRecord` (реальный `end_of_data`, не эвристика).
5. Suite зелёный; существующие evaluator-тесты обновлены под композицию.
