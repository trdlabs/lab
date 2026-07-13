# Ревизия воркфлоу проверки гипотез — как оценивать «гипотеза улучшила стратегию»

**Дата:** 2026-07-11
**Статус:** анализ, кода нет. Документ — основа для плана реализации.
**Метод:** трассировка актуального `main` тремя graph-агентами (leg 1: анализ paper-трейдов → генерация; leg 2: бэктест → приёмка; leg 3: интеграция → paper) + сверка с roadmap `docs/superpowers/specs/2026-06-30-backtest-research-orchestrator-roadmap.md` + разбор внешних рекомендаций (Perplexity, 2026-07-11).

---

## 0. TL;DR

Архитектурно воркфлоу правильный и уже содержит больше «взрослых» механизмов, чем предполагает вопрос: детерминированная приёмка (никакой LLM не судит метрики), same-run-context сравнение variant vs baseline, trade-based holdout, WFO-контур, fingerprint-дедуп гипотез, бюджетные гейты. Но есть четыре критических пробела, из-за которых ответ на вопрос «не убила ли гипотеза хорошие сделки» сегодня в принципе не проверяется:

1. **Нет trade-level сравнения baseline↔variant** — приёмка только по агрегатам. Живой прогон Цикла 1 уже показал реальный exploit: гипотезы «улучшали» net PnL воздержанием от сделок (abstention gaming).
2. **Оценочное окно бэктеста гипотез статично и in-sample** — `defaultPlatformRun` захардкожен; гейты Цикла 2 из roadmap §3 (targeted → regression → holdout) не реализованы; holdout работает только на `cycleDepth === 0`.
3. **Петля улучшения в дефолтной конфигурации — тупик**: принятая ревизия ни во что не ведёт (консолидатор off), обратно на paper стратегия автоматически не попадает.
4. **LLM не видит того, что мы думаем, что она видит**: поминутный `minuteContext` фетчится, но в промпт не рендерится; decision log есть в порту, но не подключён; `feedback` от FAIL/MODIFY заявлен в payload, но нигде не читается.

Из предложений Perplexity берём: trade-level split (в усиленном виде — как детерминированный гейт, не только отчёт), scorecard, суб-кластеризацию «не-TP2» группы, walk-forward дисциплину для Цикла 2, минимальные пороги paper→дальше. Отклоняем (на этой стадии): формальные DSR/PBO — статистический театр на выборках в 20–30 сделок; их роль у нас выполняют honest holdout + paper/canary как настоящий OOS.

---

## 1. Как воркфлоу работает НА САМОМ ДЕЛЕ (сверка с ожиданиями)

Реальная цепочка (все таск-тайпы зарегистрированы в `src/composition.ts:468-478`):

```
paper.monitor ──(window_complete: ≥30 закрытых сделок или 30 дней)──▶ research.run_cycle
  └ ничего не анализирует сам: только closedTrades + elapsed time

research.run_cycle (src/orchestrator/handlers/research-run-cycle.handler.ts:144)
  ├ evidence: до 10 последних finished-ранов + принудительно paperRunId
  ├ ЛУЗЕРЫ: top-5 по realizedPnl < 0 (сорт: худший PnL → дольше держали)   [selectSuspiciousTrades]
  ├ ВИННЕРЫ: top-5, ранжирование headroom-классом closeReason              [rankWinnersTyped]
  │   (take_profit_partial | breakeven | signal_exit | time_exit — впереди)
  ├ два прохода LLM: loss_reduction (всегда) + profit_improvement (если есть виннеры)
  │   до RESEARCHER_MAX_PER_PASS=5 гипотез на проход
  └ на каждую validated гипотезу → hypothesis.build

hypothesis.build ──▶ платформенный бэктест variant vs baseline НА ОДНОМ окне
  └ окно = services.defaultPlatformRun (composition.ts:445) — ЗАХАРДКОЖЕНО:
    HUSDT:1m, 2026-06-22..28, seed 42 — НЕ привязано к paper-периоду

backtest.completed ──▶ evaluateBacktest (детерминированная лестница, src/validation/evaluator.ts:30)
  ├ FAIL/MODIFY → авторетрай research.run_cycle (cycleDepth+1, cap 2, токен-бюджет)
  └ по завершении всех задач цепочки → revision.build

revision.build (src/orchestrator/handlers/revision-build.handler.ts:149)
  ├ берёт top-K (REVISION_BATCH_MAX=5) из proxy_passed|proxy_paper_candidate ЭТОГО цикла
  ├ детерминированный merge → комбо-бэктест → evaluateRevision
  └ greedy-деградация: комбо отклонено → выкинуть худшую гипотезу, повторить (≤3 прогонов)

[ТУПИК в дефолте] accepted-ревизия → revision.consolidate только если CONSOLIDATOR_ADAPTER≠off
  └ consolidate → strategy.baseline → strategy.wfo → (verdict=PAPER_CANDIDATE) → paper.start
```

Расхождения с описанием воркфлоу в вопросе (важно понимать, что реально уходит в LLM):

| Ожидание | Реальность |
|---|---|
| «top-5 плохих + top-5 не дошедших до tp2» | Литерала `tp2` в коде нет. Лузеры = top-5 по PnL (однородная группа, без разбиения по причине выхода). Виннеры = top-5 с приоритетом headroom-класса closeReason — это прокси «вышли рано / оставили профит на столе» |
| «данные по каждой минуте: OHLCV, OI, ликвидации, фандинг, taker» | Поминутная таблица есть только в **микро-окне exit−10m…post-exit** (`format-market-context-math.ts:49`). Полный `minuteContext` (−20/+180 мин, `{close, volume, oi, liqL, liqS}`) **фетчится, но в промпт НЕ рендерится** (`mastra-researcher.ts:107` — только шапка + lifecycle-события). Фандинг/тейкер — только как индикаторные агрегаты на 3 точках (@entry/@exit/@post) |
| «30 минут до и 30 после» | Trade-evidence: −20/+180 мин (захардкожено). Context-math: −150 мин от входа / +60 мин после выхода (`TRADE_CONTEXT_WARMUP_MIN=150`, `TRADE_CONTEXT_TAIL_MIN=60`) |
| «лента решений почему вошёл/не вошёл» | `getDecisionLog` есть на порту `BotResultsReadPort` (`src/ports/bot-results-read.port.ts:58`), но хэндлер его **не вызывает**. Осознанный дефер SP-3, так и не поднятый |

---

## 2. Что уже есть и работает правильно (не трогать)

1. **Детерминированная приёмка.** Все вердикты — чистые функции: `evaluateBacktest`, `evaluateRevision`, `evaluateExperiment`, `evaluateStrategyBaseline`, `evaluateConsolidation`. LLM участвует только в точках *суждения о ходе поиска* (GATE1, sweep-designer, result-interpreter в WFO), никогда — в оценке метрик. Это ровно принцип «нарратив не спасает стратегию», и он у нас уже соблюдён лучше, чем во многих референсных системах.
2. **Same-run-context сравнение**: variant и baseline гоняются на одном датасете/периоде/seed; ревизии сравниваются с re-run принятой ревизии по identity `(manifestId, paramsHash, bundleHash)`.
3. **Лестница `evaluateBacktest`** (`src/validation/evaluator.ts:30-44`): insufficient_sample → no_improvement → drawdown_regression → fragile_pnl (top-trade ≥50% PnL) → strong edge → PASS. Пороги env-управляемые (`EVAL_*`).
4. **Дедуп и память гипотез**: fingerprint против всех прошлых (validated И rejected), advisory-список похожих гипотез в промпте, `activeOverlayRules` из последней accepted-ревизии («proxy ≠ proven» соблюдён).
5. **Trade-based holdout** (#119) с политикой по числу сделок (§2.5), `INCONCLUSIVE ≠ FAIL`, low-confidence флаги.
6. **Бюджетная дисциплина**: токен-бюджет per-correlationId, MAX_CYCLE_DEPTH=2, лимиты WFO-раундов; исчерпание всегда деградирует в INCONCLUSIVE + событие, не падает.
7. **Ledger-инфраструктура**: `hypothesis_proposal` (+proxyMetrics, dropped-причины), `evaluation`, `research_experiment`/`experiment_evaluation`, `paper_submission`, event-stream. Для scorecard (см. §5) почти все данные уже персистятся.

---

## 3. Разбор предложений Perplexity: берём / адаптируем / отклоняем

### 3.1 Берём

**(a) Trade-level split «плохие исправлены / хорошие целы / нейтральные не деградировали»** — главная по ценности рекомендация, и у нас есть эмпирическое подтверждение необходимости: в первом живом прогоне Цикла 1 гипотезы обыгрывали net-PnL воздержанием (7 сделок tp/hard_stop → 1 позиция end_of_data). Сейчас в приёмке ноль trade-level логики: единственный trade-shape сигнал — `topTradeContributionPct`. При этом трейды обоих ранов уже доступны (`runTrades.getRunTrades` используется для границы holdout). Реализация дешёвая и детерминированная — см. R2 в §5.

**(b) Hypothesis scorecard** — да, но не как LLM-заполняемая форма (у Perplexity двусмысленно), а как **детерминированный артефакт**, собираемый из уже существующих ledger-строк + новых trade-level метрик. Рендер в markdown → artifacts + read-API. См. R5.

**(c) Суб-кластеризация «не дошедших до TP»** — согласен. Сейчас лузеры — однородная группа (сорт только по PnL); `closeReason` в промпте есть per-trade, но пайплайн не бакетирует и не даёт per-cluster статистику. SL / time_exit / breakeven — действительно разные паттерны провала, и смешение размывает гипотезы. См. R8.

**(d) Walk-forward дисциплина для оценки гипотез (train=генерация / test=оценка)** — согласен с диагнозом, но заострю: у нас проблема даже глубже, чем «то же окно». Гипотезы генерируются из paper-трейдов, а оцениваются на **статичном фикстурном окне** `2026-06-22..28`, которое (i) может пересекаться с paper-периодом → in-sample, (ii) всего 6 дней → почти всегда `insufficient_sample`/`mode:'none'` для holdout (minHistoryDays=30). Механизм no-leakage границы T уже спроектирован в roadmap §2.5 и реализован для Цикла 1 — его нужно довести до Цикла 2 (гейты A/B/C из §3 roadmap). См. R3.

**(e) Минимальный порог сделок и доверительная оценка перед выводами из paper** — частично уже есть (`PAPER_WINDOW_MIN_TRADES=30`, low-confidence лестница §2.5). Добавить стоит: bootstrap-CI на expectancy paper-окна (дёшево, детерминированно) как флаг в scorecard, не как жёсткий гейт. См. R11.

### 3.2 Адаптируем

**(f) Aggregate guard rails (Sharpe, Calmar, PF, MaxDD, Total Return с ratio-порогами).** Половина уже есть в лестнице (PnL delta, MaxDD delta +2pp, PF≥1.5 для strong, winRate≥baseline). Чего реально не хватает:
- **Sharpe/expectancy отсутствуют в гипотезной лестнице** (Sharpe есть только в strategy-baseline lane). На 6-дневных окнах Calmar — шум, не добавлять.
- Ratio-пороги Perplexity (variant ≥ baseline × 0.95) хуже наших дельт с допуском при малых базах (baseline PnL около нуля → ratio взрывается). Оставить дельты, добавить expectancy-based margin: `minPnlDeltaUsd=0` на 20 сделках — это монетка; порог должен быть ≥ k·σ(trade PnL) или требовать min expectancy delta. См. R6.

**(g) Множественное тестирование (DSR при N гипотез).** Проблема реальна, решение — нет (см. 3.3). Наш вариант: (i) финальная проверка merged-ревизии на **holdout-окне, не участвовавшем в отборе top-K** — это структурно убивает selection bias, который DSR лишь оценивает post-hoc; (ii) в scorecard всегда писать «выбрано из N проверенных» — честная отчётность о поисковом пространстве. См. R7.

**(h) Parameter sensitivity / stability.** Релевантно только WFO-контуру (не оверлей-гипотезам, у которых параметров обычно мало). В top-N pre-filter добавить предпочтение «плато» над «пиком» (сосед по сетке тоже прибыльный → выше ранг). Дёшево, соответствует roadmap-принципу «fragility-penalty до LLM». См. R10.

### 3.3 Отклоняем (с обоснованием — чтобы не возвращаться)

**(i) DSR (Deflated Sharpe Ratio) и PBO (Probability of Backtest Overfitting) как гейты — сейчас НЕ внедрять.**
- Обе метрики осмысленны при: сотни+ сделок на вариант, десятки+ вариантов, стационарные распределения. У нас: 20–30 сделок на прогон, 5–10 гипотез на цикл, 6–30-дневные окна. DSR на таких входах даёт числа с огромной дисперсией — ложное чувство строгости.
- PBO требует комбинаторных разбиений (CSCV) — умножение числа бэктестов на ~16× при нашей стоимости прогона не окупается.
- Функциональную роль этих метрик (защита от «лучший из N — случайность») у нас закрывает **структурная** дисциплина: генерация видит только train (граница T), финальный арбитр — holdout/paper/canary, которых отбор не касался. Это подход Pardo/walk-forward школы: не поправлять статистику после подглядывания, а не подглядывать.
- Вернуться к DSR можно, когда появится ≥60 дней истории и multi-fold WFA (roadmap 6.0 🔴-стадия) — там появятся и выборки, на которых он что-то значит.

**(j) Полный WFO на каждую гипотезу** — не нужно: гипотеза-оверлей это не параметрическая оптимизация; ей достаточно train/regression/holdout split (3 прогона), а не сетка×фолды.

**(k) LLM-заполняемый scorecard / LLM-вердикты** — сохранить текущий принцип: LLM генерирует и интерпретирует, детерминизм решает. Perplexity здесь размыт («который LLM или ты сам заполняете») — у нас заполняет код.

---

## 4. Найденные проблемы сверх Perplexity (по трассировке кода)

### Разрывы проводки (ломают петлю)

| # | Проблема | Где |
|---|---|---|
| W1 | **Тупик петли улучшения**: accepted-ревизия при `CONSOLIDATOR_ADAPTER=off` (дефолт) не триггерит ничего — ни re-baseline, ни WFO, ни paper. Правила ревизии живут только как контекст для следующего researcher-промпта | `revision-build.handler.ts` (энкью consolidate только при консолидаторе); `env.ts:287` |
| W2 | **`feedback` мёртв**: `enqueueResearchRetry` кладёт `{hypothesisId, decision, reasons}` в payload ретрая, схема его декларирует, но тело хэндлера нигде не читает → причины FAIL/MODIFY не доходят до промпта нового цикла | `backtest-completed.handler.ts:46-74`; `research-run-cycle.handler.ts:37-41` |
| W3 | **`minuteContext` фетчится, но не рендерится** в промпт (−20/+180 мин поминутных данных по лузерам тратят время/IO впустую); decision log не подключён вовсе | `mastra-researcher.ts:107` (`forensicBundleText`); `bot-results-read.port.ts:58` |
| W4 | `strategy.baseline` энкьюит `strategy.wfo` **безусловно**, даже при FAIL-вердикте бейзлайна → LLM-sweep жгёт бюджет на заведомо мёртвой ветке | `strategy-baseline.handler.ts:83` |
| W5 | Гипотезы unsupported-only циклов навсегда зависают в `proxy_*` (признанный follow-up) | `revision-build.handler.ts` ~233 |

### Методология оценки

| # | Проблема | Где |
|---|---|---|
| M1 | **Нет trade-level гейта** (см. §3.1a): abstention gaming, обрезание виннеров и «улучшение» за счёт end_of_data позиций не детектируются | `evaluator.ts`, `revision-evaluator.ts` |
| M2 | **Статичное in-sample оценочное окно** `defaultPlatformRun` (HUSDT:1m, 2026-06-22..28, seed 42) для hypothesis.build и revision.build; holdout только на `cycleDepth===0`; ревизии вообще без OOS | `composition.ts:445`; `hypothesis-build.handler.ts:117` |
| M3 | **Ratchet-оверфит ревизий**: каждая accepted-ревизия становится новым baseline, и следующий цикл снова требует `deltaNetPnl > 0` **на том же окне** → монотонная подгонка под один срез данных, стек ревизий = стек in-sample решений | `revision-build.handler.ts:293-324` |
| M4 | **Дисбаланс порогов**: WFO-floor для paper почти тривиален (trades≥1, PF≥1, Sharpe>0 на holdout) против строгой гипотезной лестницы (minTrades 20, strong=+100 USD, PF≥1.5). Слабейшие ворота стоят на самом дорогом переходе (paper) | `strategy-baseline-evaluator.ts:5,14` |
| M5 | `minPnlDeltaUsd=0` как порог улучшения на ~20 сделках статистически неотличим от шума; нет CI/margin | `evaluator.ts:15-22` |
| M6 | Отсутствие regression-gate по «нормальному» окну: гипотеза, чинящая 5 плохих сделок, оценивается сразу на всём окне — targeted/regression разделение из roadmap §3 не реализовано | roadmap §3 Cycle 2, gates A/B |
| M7 | paper.monitor не смотрит на PnL/просадку вообще — только closedTrades + время: истекающий кровью чемпион будет спокойно наблюдаться 30 дней | `paper-window.ts:76-91` |
| M8 | Selection bias top-K: revision.build выбирает top-5 по тому же метрику/окну, по которым потом принимает (см. §3.2g) | `hypothesis-score.ts:65-107` |

### Гигиена порогов/конфигов

| # | Проблема | Где |
|---|---|---|
| C1 | `minTrades: 20` захардкожен литералом в revision-lane — игнорирует `EVAL_MIN_TRADES` | `revision-build.handler.ts:324` |
| C2 | Пороги `evaluateRevision` (drawdown +2.0pp, fragility 50) захардкожены, без env | `revision-evaluator.ts:26-53` |
| C3 | HoldoutPolicy — только константы кода, env-ручек нет | `research-experiment.ts:33-40` |
| C4 | Окна trade-evidence (−20/+180) и trade-context (−150/+60) захардкожены/полу-env; заявленная в вопросе «±30 мин» конфигурация не существует | `research-run-cycle.handler.ts` |

---

## 5. Рекомендации (нумерация R* — для плана реализации)

### P0 — восстановить честность петли (без этого остальное — косметика)

**R1. Замкнуть Цикл 2 обратно на paper (закрыть W1).**
Путь «accepted-ревизия → re-baseline (ready-bundle) → WFO-gate → paper.start (новый чемпион)» должен существовать и без консолидатора: триггерить `strategy.baseline` в ready-bundle режиме от любой accepted-ревизии (консолидация — ортогональная оптимизация глубины стека, не условие выхода на paper). Заодно: чинить W4 (не энкьюить WFO при FAIL-бейзлайне).
*Приёмка: e2e-тест «accepted revision → paper_submission новая строка» при CONSOLIDATOR_ADAPTER=off.*

**R2. Trade-level preservation gate (закрыть M1; ядро ответа на вопрос пользователя).**
Детерминированный модуль сравнения трейдов baseline-run ↔ variant-run (оба уже доступны):
- матчинг сделок по (symbol, direction, окно времени входа ±допуск);
- классификация baseline-трейдов на 3 кластера: **source-losers** (те, из которых родилась гипотеза / все убыточные), **winners**, **neutral**;
- метрики per-cluster: сохранившиеся / исчезнувшие / новые сделки, Δexpectancy, ΔavgWin, ΔavgLoss;
- новые ступени лестницы (после drawdown_regression): `winner_degradation` (expectancy виннер-кластера variant < k·baseline, k≈0.9 env), `abstention_gaming` (totalTrades упал ниже допуска, напр. −20% env, при этом PnL-дельта достигнута в основном исчезновением сделок), `end_of_data_position` (незакрытая позиция даёт ≥X% PnL-дельты → INCONCLUSIVE);
- те же гейты в `evaluateRevision` для комбо-рана.
Это одновременно закрывает зафиксированный live-финдинг winner-preservation.
*Приёмка: регресс-тест на abstention-сценарий (гипотеза убирает все сделки кроме одной end_of_data — обязана получить FAIL/INCONCLUSIVE, не PASS).*

**R3. OOS-дисциплина для Цикла 2 (закрыть M2/M3/M6): гейты A/B/C из roadmap §3.**
- Оценочное окно привязать к данным, а не к фикстуре: период = доступная история до границы T (генерация видит `period.to = T`), holdout `[T..]` — финальный арбитр и для гипотез (все cycleDepth), и для **merged-ревизии** (комбо-ран прошёл на train → подтверждающий ран на holdout до ACCEPT). Механика границы уже есть (`resolveHoldoutBoundary`).
- Минимум: 2 прогона (train + holdout) на финального кандидата; targeted/regression разделение (гейт A: окно с плохими сделками; гейт B: нормальное окно) — второй очередью, если бюджет прогонов позволяет.
- Это же лечит ratchet M3: ревизия принимается только при неухудшении на окне, которого не видел отбор.
*Приёмка: тест «hypothesis merged только после holdout-PASS»; событие с train/holdout метриками в ledger.*

> ↔ **backtester Phase E** (см. `docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md`): held-out дисциплина усиливается серверным **E4** (server-declared qualification-окно, против которого петля не может итерировать) + lab-двойник **Outcome Embargo** на agent-memory. Lab-часть R3 = consume E4-вердикт + Embargo, а не только своя граница T.

**R4. Донести до LLM то, что считаем, что она видит (закрыть W2/W3).**
- Прокинуть `feedback` (decision+reasons прошлого FAIL/MODIFY) в промпт ретрая — поле уже в payload.
- Либо рендерить `minuteContext` (сжатая поминутная таблица по лузерам — формат уже есть для микро-окна), либо перестать фетчить; решение зафиксировать.
- Подключить `getDecisionLog` хотя бы для лузеров (сэмпл «почему не вышли раньше / почему вошли»), bounded.
*Приёмка: снапшот-тест промпта: содержит feedback-блок и (решённый вариант) minute-таблицу/decision-выдержку.*

### P1 — качество решений и наблюдаемость

**R5. Hypothesis / Cycle Scorecard (детерминированный артефакт).**
Собирается кодом из существующих ledger-строк + R2-метрик; markdown → `artifacts.put(kind:'hypothesis-scorecard')` + jsonb в `evaluation`; секции: AGGREGATE (лестница + пороги + фактические значения), TRADE-LEVEL SPLIT (кластеры из R2), ROBUSTNESS (train vs holdout, low-confidence флаги, «выбрано из N проверенных» — см. R7), VERDICT + причина. Cycle-scorecard агрегирует: сколько предложено/déduped/validated/proxy_passed/merged/dropped и почему. Рендер в office/chat completion-summary (частично есть: `buildRunCycle`).
*Ценность: это и есть «человекочитаемый ответ», который сейчас размазан по 5 таблицам БД.*

**R6. Пересборка порогов (закрыть M4/M5/C1-C3).**
- WFO-floor → поднять до уровня, сопоставимого с гипотезной лестницей: minTrades ≥ 20 (или low-confidence ветка), PF ≥ 1.2–1.5, MaxDD-cap; либо явно задокументировать «paper — дешёвый следующий фильтр, floor намеренно низкий» и компенсировать R2-гейтом в paper.monitor (M7).
- `minPnlDeltaUsd` → margin-порог: улучшение засчитывается, если ΔPnL > max(env-минимум, k·σ(baseline trade PnL)·√N) — дёшево считается из тех же трейдов.
- Env-ифицировать C1-C3 (единый `evaluatorThresholds` источник для обеих линий).

**R7. Selection-bias отчётность (адаптация DSR-идеи, M8).**
- Ledger: на цикл фиксировать N=сколько гипотез реально бэктестили; в scorecard — «champion выбран из N»;
- финальный holdout-ран merged-ревизии (уже в R3) — структурная защита;
- опционально: rank-stability сигнал (top-K по train совпадает с top-K по holdout? нет → флаг unstable_selection).

> ↔ **backtester Phase E**: N-счётчик становится **серверным** (E2 trial ledger — backtester видит каждый прогон). Lab владеет только слоями family-identity (L1 `derivedFrom` в манифесте, L2 pre-submit similarity → `familyHint`), которые делают N осмысленным. См. reconciliation §4.

**R8. Бакетирование лузеров по `closeReason` (Perplexity-пункт 1).**
В отбор и промпт: группировать лузеров по канону (`stop_loss` / `time_exit` / `breakeven`/…), давать per-cluster статистику (count, avg PnL, avg holding) и просить гипотезы адресовать конкретный кластер. Виннерам аналогично headroom-подклассы (уже наполовину есть в `rankWinnersTyped`).

**R9. Деградация-детектор в paper.monitor (M7).**
Дешёвый детерминированный kill-switch: при опросе окна считать текущий MaxDD/PnL paper-рана; при пробое порога (env) — событие `paper.degradation` + опция досрочного `window_complete` (запустить Цикл 2 раньше, не ждать 30 дней). Не LLM.

### P2 — по мере накопления данных

**R10. Plateau-preference в WFO top-N pre-filter** (см. §3.2h) — штраф изолированным пикам сетки.

**R11. Bootstrap-CI на expectancy** для paper-окна и holdout — флаг `ci_includes_zero` в scorecard (не жёсткий гейт при текущих выборках).

**R12. Canary-comparison (G5, roadmap §3 GATE CANARY)** — параллельные paper-arms baseline vs improved + детерминированное сравнение армов. Это настоящий OOS-арбитр; после R1 (петля замкнута) — самый ценный следующий контур.

**R13. Multi-fold WFA + стадийное включение DSR/PBO** — по roadmap 6.0, data-gated (VPS уже пишет историю: ~30 дней на 2026-07-11, ≥60 к ~2026-08-10).

Уточнение 2026-07-11 (вопрос пользователя «данные копятся — DSR/PBO всё ещё не нужны?»): календарные дни — не главный ограничитель. DSR требует достаточно сделок на прогон (моменты skew/kurt по трейдам — десятки-сотни сделок) и полного лога всех N испытаний (ledger это уже пишет, включая rejected). PBO/CSCV требует комбинаторной матрицы испытаний — осмысленно только там, где испытаний десятки (sweep), не 5–10 гипотез.

Стадии:
- **Сейчас (≈30 дней истории):** первый дивиденд данных — НЕ DSR, а то, что R3 заработает по-настоящему: `minHistoryDays=30` перестанет резолвить `mode:'none'`, holdout начнёт реально гейтить; eval-окно можно привязать к реальной истории вместо фикстуры (M2). Данные ускоряют P0, а не отменяют отказ от DSR.
- **≥60 дней:** multi-fold WFA (главная ценность) + **DSR как advisory-поле scorecard** (не гейт): чистая функция от ledger — N испытаний цикла + моменты трейдов holdout-рана. Наблюдаем распределение на наших выборках, порог — только после этого.
- **PBO — только в WFO-sweep линии** (точки сетки × фолды = естественная матрица испытаний; CSCV ложится на fold-матрицу с умеренной доплатой). В гипотезную линию не тащить — N всегда мал.
- **Жёсткими гейтами DSR/PBO не делать, пока не работает canary (R12)** — живой параллельный paper-arm сильнее любой post-hoc поправки статистики.

> ↔ **backtester Phase E** (РАЗВОРОТ на consume, 2026-07-12): DSR теперь считается **серверно** (E2, advisory-first, DSR+N в signed evidence) — lab его **НЕ строит**, а потребляет в scorecard. Multi-fold — **делегируется E3** (split-scheme как request-параметр, фолды = детерминир. суб-раны), а не гоняется в lab-`ParamGridRunner`. См. reconciliation §3.

**R14. Regime breakdown в scorecard** (RegimeLabeler из Phase B) — «pass_rate высокий, но только в одном режиме — слабый кандидат» (roadmap §7.5).

### Порядок для плана реализации

```
R1 (замкнуть петлю) ─┬─▶ R2 (trade-level gate) ─▶ R5 (scorecard)
                      ├─▶ R3 (OOS для Цикла 2)  ─▶ R7 (selection-отчётность)
                      └─▶ R4 (feedback/minute/decision-log в промпт)
R6, R8, R9 — независимые, параллелятся
R10–R14 — после накопления данных / после G5-prereqs
```

R2 и R3 — суть ответа на исходный вопрос «как правильно оценивать»; R1 — предусловие, чтобы оценка вообще на что-то влияла; R4 — предусловие качества самих гипотез.

---

## 6. Справочник текущих порогов (для планировщика)

| Гейт | Порог | Значение | Источник | Env |
|---|---|---|---|---|
| evaluateBacktest | minTrades | 20 | `evaluator.ts:15` | EVAL_MIN_TRADES |
| | minPnlDeltaUsd | 0 | 〃 | EVAL_MIN_PNL_DELTA_USD |
| | maxDrawdownTolerancePct | +2.0pp | 〃 | EVAL_MAX_DRAWDOWN_TOLERANCE_PCT |
| | fragilityTopTradePct | 50 | 〃 | EVAL_FRAGILITY_TOP_TRADE_PCT |
| | strongPnlDeltaUsd / minProfitFactor | 100 / 1.5 | 〃 | EVAL_STRONG_PNL_DELTA_USD / EVAL_MIN_PROFIT_FACTOR |
| evaluateRevision | minTrades | 20 (литерал!) | `revision-build.handler.ts:324` | — |
| | ΔPnL / ΔDD / fragility | >0 / +2.0 / 50 (хардкод) | `revision-evaluator.ts:26` | — |
| Holdout policy | train/holdout/lowConf/minDays | 50/30/15/30 | `research-experiment.ts:33` | — |
| WFO paper-floor | trades/PF/Sharpe | ≥1 / ≥1 / >0 | `strategy-baseline-evaluator.ts:5` | — |
| WFO budget | rounds/points/topN | 2/8/3 | `experiment-service.ts:44` | — |
| Paper window | minTrades/lowConf/minDays/maxDays | 30/15/3/30 | `env.ts:276` | PAPER_WINDOW_* |
| Ретраи | MAX_CYCLE_DEPTH / REVISION_BATCH_MAX / combo retries | 2 / 5 / 2 | handlers | — / REVISION_BATCH_MAX / — |
| Токены | RESEARCH_TASK_TOKEN_BUDGET | 200 000 | `env.ts:264` | RESEARCH_TASK_TOKEN_BUDGET |
| Генерация | RESEARCHER_MAX_PER_PASS | 5 | env | RESEARCHER_MAX_PER_PASS |
| Evidence-окна | trade-evidence / warmup / tail | −20/+180 / 150 / 60 мин | handler / env | — / TRADE_CONTEXT_WARMUP_MIN / TRADE_CONTEXT_TAIL_MIN |
| Eval-окно | defaultPlatformRun | HUSDT:1m 2026-06-22..28 seed 42 | `composition.ts:445` | — |
