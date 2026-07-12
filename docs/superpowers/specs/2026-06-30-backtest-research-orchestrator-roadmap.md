# Backtest-Research-Orchestrator + WFA/WFO + Experiment Registry — Consolidated Roadmap

**Date:** 2026-06-30
**Target repo:** trading-lab (research brain). office-панели → trading-office; опц. metadata → trading-backtester.
**Status:** IN PROGRESS — A/B.1/1-fold holdout/B2(1-fold WFO) отгружены (PR #119–#124); фиксация гапов и порядок доработки — §8 (2026-07-02).
**Supersedes/merges:** `2026-06-28-wfa-research-experiment-design.md` (WFA-дизайн) + наша развязка research-потока (backtester PR #71) + идея pre-paper параметрического sweep.

---

## 0. Что объединяем

Три ранее разрозненных куска — это **одна система**:
1. **Research Experiment Registry / ledger** (WFA-дока) — persistent-контейнер серий backtest-прогонов.
2. **WFA + WFO** — валидация (robustness по окнам/режимам) И оптимизация параметров (sweep) без оверфита.
3. **Backtest-Research-Orchestrator + decision-agent** — двигатель воронки + LLM-суждение «что дальше».

Вход обеспечен: backtester PR #71 — `produceStrategyEvidence` на verdict-failed **возвращает метрики как данные** (не аборт); подпись только на `passed`. Research-петля получает результат как есть.

---

## 1. Ядро: Experiment как сущность (= ledger)

`research_experiment` + `experiment_run_member` + `experiment_evaluation` (схема из WFA-доки §3). Это **и реестр серий, и ledger прошлых прогонов** для decision-agent'а. Одна сущность.

**Дополнения к схеме WFA-доки:**
- `experiment_type` += **`walk_forward_optimization`** (WFO/sweep) — был исключён в §10 WFA-доки, возвращаем как первоклассный тип.
- `research_experiment.parameter_grid jsonb` — пространство поиска для WFO (`{ param: [values] | {min,max,step} }`).
- `experiment_run_member.params jsonb` (+ существующий `params_hash`) — `request.params` конкретного прогона.
- `experiment_run_member.oos boolean` — был ли этот прогон out-of-sample (test-окно WFO) vs in-sample (train-оптимизация). **Агрегаты считаются ТОЛЬКО по `oos=true`.**
- `research_experiment.holdout_policy jsonb` — политика разбиения по ЧИСЛУ СДЕЛОК (см. §2.5): `{ minTradesTrain:50, minTradesHoldout:30, lowConfidenceThreshold:15 }`.
- `experiment_run_member.trade_count int` + `aggregate_metrics.low_confidence_holdout boolean` + `experiment_evaluation.flags.low_confidence_holdout` — холдаут набрал < `minTradesHoldout`, но ≥ `lowConfidenceThreshold` (допускаем с пометкой).

---

## 2. WFO (sweep) — честно, без оверфита, без пересборки

**Инвариант (обязательный, принят):** sweep = **walk-forward optimization**, НЕ grid-pick-best. На каждом fold: оптимизируешь params на **train**-окне → фиксируешь лучший набор → меряешь на **test**-окне (OOS). Агрегат — только по OOS. Выбор params по тем же данным, где меришь, запрещён.

**Реализация (принято): через `request.params` на ЗАФИКСИРОВАННОМ `bundle_hash`.** Бэктестер мержит `request.params` поверх `manifest.params` (`simulateTarget`). Значит sweep = тот же бандл, разные `request.params` per-run → дёшево, **не трогает byte-proof/bundle_hash инвариант**, пересборка не нужна. `params_hash` различает прогоны.

**Декомпозиция (LLM vs детерминизм):**
- LLM (sweep-designer): предлагает **комбинированную сетку по нескольким params СРАЗУ** (минимум вызовов) исходя из профиля стратегии.
- Детерминизм: строит fold-план, гоняет сетку × foldы через backtester, считает OOS-агрегаты, **pre-filter до top-N лучших комбинаций по OOS-метрике**.
- LLM (result-interpreter): видит **только top-N** (не весь sweep) → решает: взять лучший набор / догнать сетку по ещё одному param / стоп.

---

## 2.5 Holdout / нарезка foldов — по ЧИСЛУ СДЕЛОК, не по дням (обязательно)

Календарный holdout («последние N дней») для low-freq стратегии набирает 3–5 сделок → статистически бессмысленный verdict. Единица — **число сделок** (академический минимум ≥30 на тест-период). Без этого orchestrator поделит по времени и выдаст мусор.

**Политика (`HoldoutPolicy`):** `minTradesTrain=50`, `minTradesHoldout=30`, `lowConfidenceThreshold=15`.

**Алгоритм (граница T):**
1. **Переиспользовать GATE 0 sanity** — он уже гоняется на полном периоде и даёт `tradeSummary` (распределение сделок по времени). **Отдельный прогон НЕ нужен** — граница считается из sanity бесплатно.
2. Найти дату `T`: самую позднюю, после которой накоплено ≥ `minTradesHoldout` сделок (по baseline-распределению).
3. `train = [..T)`, `holdout = [T..]`. Для WFA так же режем КАЖДОЕ test-окно по накоплению ≥`minTradesHoldout` (variable-length по времени), а не фикс. `test_days`.

**Граница фиксируется ОДИН раз из baseline на весь эксперимент.** params (sweep) меняют trade-распределение; если каждый param-set считает свою границу — наборы несравнимы. Поэтому T фикс по baseline, а `member.trade_count` в holdout — **per-member флаг валидности**, не сдвиг границы.

**Если сделок физически мало** (low-freq, holdout < `minTradesHoldout`):
- `≥ lowConfidenceThreshold` (15) → допускаем с флагом `low_confidence_holdout=true`; **paper-период увеличиваем компенсаторно** (paper становится основной валидацией для редкотрейдящих).
- `< lowConfidenceThreshold` → `INCONCLUSIVE` (не FAIL — это coverage, не провал); не продвигать в paper, копить данные.

**Политика по частоте (дефолты, configurable):**

| Данных | Частота | Holdout-окно | Min trades |
|---|---|---|---|
| < 30 дней | — | нет, всё train | — |
| ≥ 30 дн | high (>5/день) | посл. 3–5 дн | 30 |
| ≥ 30 дн | mid (1–5/день) | посл. 7–14 дн | 30 |
| ≥ 30 дн | low (<1/день) | посл. 21–30 дн | 15–30 (low_confidence) |

`HoldoutPolicy` хранится в `research_experiment` → каждый эксперимент знает, как был разбит период (видно в office).

**No-leakage — конкретный механизм (для ОБОИХ циклов):** «LLM не видит holdout» = при выдаче контекста агенту передаётся **`period.to = holdout_start_date (T)`**; всё после T агент не получает. Граница T **фиксирована на момент генерации** конкретной гипотезы/sweep (двигается вперёд только при накоплении данных — прошлый holdout уходит в train, это нормально).
- **Цикл 1 (новая стратегия):** backtest на train `[..T)` → если PASS → holdout `[T..]` = независимая финальная проверка перед paper. train-PASS + holdout-FAIL → `FAIL`/`MODIFY`, на paper НЕ идём.
- **Цикл 2 (улучшение):** hypothesis-proposer видит paper-losses + историч. контекст **только из train** (`period.to=T`) → targeted/regression внутри train → финальная проверка на holdout (агент его не видел ни при генерации, ни при оценке) → paper canary.

Тот же механизм закрывает WFO: train-окно fold'а = контекст оптимизации, test-окно = OOS (агент/оптимизатор не выбирает params по test).

---

## 3. Orchestrator — порядок воронки (с принятым уточнением)

Двигатель не авто-sweep'ит. Порядок для **новой стратегии**:

```
build (bundle_hash зафиксирован)
 → [GATE 0] sanity backtest (1 run, дефолтные params): исполняется? trades>0? метрики не мусор?
      FAIL → reject
 → [GATE 1] baseline backtest (1 run, as-authored params)
      → result-interpreter (LLM): результаты приемлемы? есть ли смысл искать лучше?
          «достаточно» → к GATE 2
          «стоит улучшить» → sweep-designer (LLM) даёт комбинированную сетку
            → WFO sweep (детерминизм: сетка×foldы, OOS-агрегаты)
            → pre-filter top-N (детерминизм)
            → result-interpreter (LLM, видит top-N): выбрать params / ещё один раунд sweep / стоп
 → [GATE 2] WFA validation выбранного набора (robustness: regime breakdown, fragility flags)
      pass_rate≥порог, нет fragility → PAPER_CANDIDATE
 → platform paper admission (через 036 intake; подпись backtester'а на passed)
 → (после paper) Цикл 2 — hypothesis-proposer (существующий researcher)
```

**Принципы:**
- LLM — только в точках **суждения** (нужен ли sweep / выбор набора / promote-iterate-stop). Перебор, агрегация, фильтрация — детерминированный код.
- LLM **никогда не получает весь sweep** — только top-N после детерминированного pre-filter.
- Каждый прогон → `experiment_run_member` (ledger). Decision-agent читает агрегаты + историю из ledger'а, не сырые тысячи строк.

### Цикл 2 (paper-improvement) — тот же orchestrator + canary-comparison gate

**Модель (принято): orchestrator = ЕДИНЫЙ decision-engine для ОБОИХ циклов.** Контуры различаются только **генератором** (sweep-designer params ↔ hypothesis-proposer overlays); **funnel + оценка backtest'а + решение — один движок**. hypothesis-proposer только придумывает; результат overlay-бэктеста анализирует orchestrator (не proposer).

```
paper-losses (ops-read forensics ops.4/ops.5)
 → hypothesis-proposer (LLM): гипотеза                           [генерация]
 → builder: overlay-бандл
 → ORCHESTRATOR гонит funnel (experiment_type='paper_improvement'):  [анализ+решение]
     [GATE A] targeted backtest (проблемное окно train) → улучшение vs baseline (delta)?
     [GATE B] regression backtest (нормальное окно train) → нет деградации?
     [GATE C] holdout backtest (OOS) → держится?
   → PROMOTE
 → [GATE CANARY] paper canary: overlay-улучшенная стратегия ПАРАЛЛЕЛЬНО с текущей (side-by-side)
 → canary-comparison (orchestrator): сравнить два paper-arm'а по ops-read →
     LLM-суждение «улучшение реально → applied / нет → discard»
```

**Canary-comparison — ТРЕТЬЯ точка анализа** (≠ backtest-оценка, ≠ генерация гипотез): сравнение **ДВУХ paper-прогонов** (baseline vs canary) по ops-read обоих arm'ов = delta на ЖИВЫХ данных (настоящий OOS, не историч.). Детерминированное стат-сравнение arm'ов + LLM-суждение. Домен orchestrator'а (не отдельный агент). Решение: применить overlay к стратегии / откатить. Оценка цикла 2 везде **delta vs baseline** (улучшение), не абсолютный порог.

---

## 4. Два агентных контура + общий низ

| Контур | Когда | Вход | LLM-роль |
|---|---|---|---|
| **pre-paper** (sweep-designer + result-interpreter) | новая стратегия, до paper | профиль + baseline/OOS-агрегаты (top-N) | предложить search-space, интерпретировать OOS, решить iterate/stop |
| **post-paper** (hypothesis-proposer = текущий researcher) | деградация paper/live | ops-read paper/live forensics (ops.4 trade-evidence + ops.5 close-reason) | предложить overlay-гипотезы |

**Общий низ — `result-analysis` слой** (агрегаты, сравнение с историей из ledger, fragility-эвристики, **сравнение двух arm'ов для canary**). Не дублировать между контурами; два тонких драйвера поверх.

**Таблица = только ГЕНЕРАТОРЫ.** Анализ backtest-результата (funnel, оценка, выбор params/overlay, promote/discard) и **canary-comparison** — это **единый orchestrator/decision-engine** для обоих циклов (§3), НЕ отдельный анализатор под цикл 2. proposer/sweep-designer генерируют — orchestrator решает.

---

## 5. Token-economy / детерминизм (явные правила)

- Sweep-комбинации — **одним LLM-вызовом** (мульти-param сетка), не по одному параметру.
- В LLM уходят **агрегаты и top-N**, не сырые decisionRecords/трейды.
- Pre-filter (top-N по OOS sharpe/pnl с штрафом за fragility) — чистая функция, до LLM.
- Verdict-пороги (`DEFAULT_THRESHOLDS`, sharpe>0 для admission) — на стороне backtester'а, не дублировать; orchestrator имеет СВОЙ research-порог («стоит ли итерировать», мягче admission).

---

## 6. Roadmap (фазы, зависимости, параллелизация)

### 6.0 Порядок поставки — data-staged (что делать СЕЙЧАС vs когда накопятся данные)

Фазы ниже (A–F) — архитектура/зависимости. Но **порядок реализации диктуется доступностью данных**: полная многофолдовая WFA + WFO sweep требуют ≥60 дней истории, которых пока нет. Поэтому:

**🟢 СЕЙЧАС (данных мало, ни одной стратегии на paper):** дёшево и максимально полезно.
1. **Holdout Policy** (trade-based + `none`/`time` fallback, `low_confidence`) — Phase B.1, но в **single-split** виде.
2. **Experiment Registry / ledger** — Phase A (фундамент).
3. **Train+Holdout двухфазный flow** — это **1-фолдовая WFA**: sanity → граница T (из sanity) → train run `[..T)` → если PASS → holdout run `[T..]` → holdout PASS = PAPER_CANDIDATE, FAIL = `holdout_failed`. Подмножество Phase B (без multi-fold). Гарантия: **ни одна стратегия не идёт на paper без holdout**.

**🟡 КОГДА появятся paper-losses:** Цикл 2 — targeted → regression → robustness (Phase C post-paper contour / hypothesis-proposer). office-панели (Phase E) — в любой момент для видимости.

**🔴 КОГДА данных ≥60 дней:** полная **многофолдовая WFA** (Phase B full) + **WFO sweep** (Phase B2) + **decision-orchestrator** с воронкой sweep (Phase C full §3). FoldPlanBuilder/orchestrator обобщаются с 1 фолда на N. Это data-gated ядро оптимизации+решения.

> Зависимости архитектурные (A→B.1→B→B2→C/D/E) сохраняются; меняется лишь, какой ОБЪЁМ каждой фазы поставляем сейчас (1-фолд) vs позже (N-фолд + sweep).

### 6.1 Фазы (архитектура/зависимости)


**Phase A — Experiment Registry / ledger (фундамент, блокирующий).** lab. Таблицы (`research_experiment`+`parameter_grid`, `experiment_run_member`+`params`/`oos`, `experiment_evaluation`), `ResearchExperimentRepository`, `ExperimentService` (create/addMember/finalize), Read API `GET /v1/experiments[...]`. Не трогать существующий backtest-flow. → ВСЁ зависит от A.

**Phase B — WFA core (validation).** lab. `FoldPlanBuilder`, `WFAOrchestrator` (parallel fold dispatch, resume по существующим members, `workflowId=experiment_id`/`correlationId=fold_id`), `WFAAggregateComputer`, `WFAEvaluator`, `RegimeLabeler` (эвристика по OHLCV из mock/platform). Инвариант: bundle_hash фикс, OOS-only агрегаты.

**Phase B.1 — Holdout/fold sizing по числу сделок (ДО основной WFA-нарезки).** lab. `HoldoutPolicy` в `FoldPolicy` (trade-count единица), `HoldoutBoundaryResolver` (берёт `tradeSummary` из GATE 0 sanity → граница T, `lowConfidence`), `FoldPlanBuilder` режет test-окна по накоплению ≥`minTradesHoldout`. Флаг `low_confidence_holdout` в aggregate/flags. **Без B.1 нельзя строить fold-план** (иначе деление по дням → мусорный verdict для low-freq).

**Phase B2 — WFO (sweep) поверх B.** lab. `ParamGridRunner` (сетка × foldы через `request.params`, train-optimize/test-OOS), `top-N pre-filter`, sweep-designer + result-interpreter контур. Зависит от B (fold-механика) + A (ledger).

**Phase C — Orchestrator + decision-agent.** lab. Двигатель воронки §3 (sanity→baseline→[sweep?]→WFA→decision), вызывает B/B2, пишет ledger, в точках суждения зовёт LLM. + Цикл 2 bridge к hypothesis-proposer.

**Phase D — Paper-candidate bridge.** lab. `PAPER_CANDIDATE` → 036 platform intake (aggregate_metrics + WFA/WFO summary как evidence).

**Phase E — office-панели.** trading-office (отдельный репо). experiment list / WFA fold timeline / aggregate card / regime heatmap. Source = lab read API.

> ⚠️ **Коллизия имён (2026-07-12):** «lab Phase E» здесь = office-панели. НЕ путать с **«backtester Phase E»** — это анти-оверфит трек (E1–E5: DSR/walk-forward/held-out/novelty) в репо backtester. Строгость против оверфита теперь **backtester-owned**; lab местами переходит с build на consume (DSR/multi-fold). Граница и lab-обязательства: `docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md`.

**Phase F — backtester run-metadata (опц.).** echo `workflowId`/`correlationId`, `GET /v1/runs?workflowId`. MVP не нужен.

**Параллелизация:** A — первым, один инстанс (блокирует). После A и стабилизации experiment read-API: **инстанс 1** = lab-ядро (B → B2 → C → D, последовательно — общая fold/aggregate-механика); **инстанс 2** = office-панели (E, читает read-API). F — опц./позже. Выигрыш умеренный (масса — последовательное lab-ядро); office разумно отдать параллельно.

---

## 7. Инварианты / gotchas

1. **No leakage / OOS-only:** WFO выбирает params на train, агрегат только по `oos=true`. bundle_hash фикс на весь эксперимент.
2. **WFO ≠ admission:** sweep/WFA — evidence. Подпись + paper admission — отдельный шаг (backtester verdict на passed + platform intake).
3. **LLM не флудить:** только агрегаты + top-N; перебор/фильтр — детерминизм.
4. **INCONCLUSIVE ≠ FAIL:** мало сделок (<min_trades_per_fold) — coverage-проблема, не провал.
5. **Regime-awareness:** pass_rate высокий, но только в одном режиме — слабый кандидат; regime_breakdown обязателен.
6. **Research-порог ≠ admission-порог:** orchestrator решает «итерировать ли» мягче, чем sharpe>0 для подписи.
7. **backtester остаётся single-run** — вся серия/смысл в lab.
8. **Единица holdout/fold = число сделок, не дни** (§2.5). Граница T фикс из baseline (sanity) на весь эксперимент; per-param holdout-trade-count — флаг валидности. `INCONCLUSIVE` при < `lowConfidenceThreshold`; `low_confidence_holdout` + компенсаторно длиннее paper при `[lowConfidence..minTradesHoldout)`.

---

## 8. Фиксация статуса и гапов — 2026-07-02 (gap-анализ полного конвейера)

Сверка «код vs этот roadmap vs целевая двухцикловая система» (4 graph-агента по lab/platform/mock/sdk).

### Отгружено (фазы → PR)

- **Phase A + B.1 + 1-fold train/holdout** — PR #119 (registry, trade-based holdout, no-leakage) + #120 (baseline lane) + #121 (risk/exec refs).
- **Phase B2 (WFO contour, 1-fold)** — PR #122/#123 (GATE1 → sweep-designer → grid × `request.params` → top-N → result-interpreter → OOS-verdict); Gate1 model-eval — PR #124.
- **Цикл 2, генератор** — researcher два прохода 5+5 (loss_reduction + profit_improvement, headroom-ранжирование победителей), per-trade forensic (lifecycle + минутный контекст) — PR #107–#117.
- **Критик** — HITL в чате + авто в воркере (PR #88/#91), но default OFF (`STRATEGY_PREFLIGHT_CRITIQUE=false`; demo = fake-адаптер).
- **Evaluator** — baseline-relative детерминированная лестница (`evaluateBacktest`); retry FAIL/MODIFY с `cycleDepth+1` (cap 2) + токен-бюджет.

### Гапы (порядок доработки — принят 2026-07-02)

1. **G1 — Оркестрация baseline/WFO (ТЕКУЩИЙ СЛАЙС).** Baseline/WFO живут только в CLI (`scripts/run-strategy-baseline.mts`, `run-strategy-wfo.mts`), не зарегистрированы как task types (composition.ts: только onboard / run_cycle / hypothesis.build / backtest.resume / backtest.completed) → из чата недостижимы. **Самоблок WFO:** скрипт пересобирает бандл LLM-билдером → недетерминизм → `bundleHash ≠ baseline.bundleHash` → fail-fast. Fix: персистить `strategy_bundle` artifact-ref на experiment row и реконструировать бандл, не пересобирать. Сюда же: budget kill-switch wiring в WFO-контур.
2. **G2 — Paper-мост (Phase D).** В lab «paper» = только лейбл `PAPER_CANDIDATE` (событие, тупик). Платформа готова целиком: intake 036 `POST /intake/paper-candidate` → smoke-gate 060 → `bot_bundle` → `materializeBot` → paper host 053/054 → ops-read (`/ops/candidates/{id}`, `/ops/runs?mode=paper`). SDK 0.9.0 (уже вендорен) даёт `submitPaperCandidate` + `createHttpIntakeTransport`, `source:'trading-lab'` зарезервирован. Нужен lab-порт (PaperIntakePort) + **champion-запись** победителя sweep (сейчас params живут только holdout-member'ом в ledger). mock-platform paper НЕ симулирует → тесты через fake transport.
3. **G3 — Ревизии стратегии + merge гипотез.** Сейчас топология «звезда от baseline»: каждый оверлей ложится на исходный `strategy:${profile.id}`, merge/стекинга нет (0 вхождений), вердикт бэктеста не возвращается на `HypothesisProposal` (нет status-update), `activeOverlayRules` подаёт schema-validated (не backtest-proven). Нужна сущность «ревизия» (baseline v2 = baseline + принятые оверлеи), гипотезы N+1 — поверх ревизии. Отдельный дизайн.
4. **G4 — Триггер Цикла 2 + адаптивная длительность.** §2.5-политика (trades/day → длина paper/бэктеста, компенсаторный paper для low-freq) не реализована: период = статический `defaultPlatformRun`, автозапуска `research.run_cycle` по завершении paper-окна нет. Backtest-period HITL — backlog.
5. **G5 — Canary-comparison (§3, GATE CANARY)** — не начат.
6. **G6 — Каналы + включение критика.** Telegram/crawler — enum-заглушки в `TASK_SOURCES`, кода нет. Критик включить после paid eval выбора модели.
7. **G7 — Live-верификация + видимость.** Известный блокер живых прогонов: tradeCount=0 (long_oi детектит дамп, не эмитит вход — builder-faithfulness/1h-гранулярность). Phase E (office-панели экспериментов) не начата — вердикты видны только в БД/консоли. После каждого слайса — сквозной живой прогон.

---

## 9. Открытые вопросы (на before-impl уточнение)

- Оптимизатор внутри train-окна WFO: полная сетка vs coarse-to-fine? (старт — полная сетка top-N, позже coarse-to-fine для экономии прогонов).
- Source OHLCV для RegimeLabeler: mock `/historical/rows` (demo, без creds) vs platform.
- Где decision-agent берёт «прошлые результаты»: ledger (lab) — да; нужен ли отдельный summary-материализатор для промпта.
- Mastra workflow vs plain service для orchestrator'а (следовать существующим lab-паттернам).
