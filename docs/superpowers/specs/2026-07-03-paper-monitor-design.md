# Slice G4 — paper.monitor: наблюдение paper-рана, адаптивное окно, автотриггер Цикла 2

**Date:** 2026-07-03
**Status:** DESIGN — ждёт ревью пользователя. Пользователь был AFK на вопросе о платформенных гапах — принят рекомендованный вариант «толерантный монитор + handoff» С ОГОВОРКОЙ (см. §2, помечено ⚠️ ДЛЯ РЕВЬЮ: прецедент Feature 038 допускает выбор «блокироваться на платформе»).
**Parent:** roadmap §8 гап G4 (первая половина: мониторинг+триггер; адаптивная длительность БЭКТЕСТА и backtest-period HITL — вне scope); поверх G2b (PR #129).

## 1. Цель

Замкнуть Цикл 2: после отправки чемпиона на paper (G2b) лаб сам наблюдает paper-ран через ops-read, решает по адаптивной политике (§2.5 roadmap — по ЧИСЛУ СДЕЛОК, не по дням), когда окно наблюдения набрано, и автоматически запускает `research.run_cycle` (двухпроходный researcher по loss/profit сделкам уже умеет paper-данные через BotResultsReadPort).

Ключевой факт платформы (проверено): частичные результаты (closed trades + summary) читаются ПОСРЕДИ рана без гейта на статус, а paper-ран не завершается сам (только при остановке хоста). Значит «окно наблюдения» — целиком lab-side решение. Это идеально совпадает с §2.5.

## 2. Платформенные гапы и шов ⚠️ ДЛЯ РЕВЬЮ

Два подтверждённых гапа платформы:
1. **Нет автозапуска** paper-бота после admission/promotion: bot_bundle создаётся (bundleId == candidateId), но хост подхватывает бандлы только при (ре)старте с `HOST_BOTS=bundle:<candidateId>`.
2. **Нет связки candidateId→runId** в ops-read: у candidate-view нет runId, у run-row нет bundleId/hash; единственный сквозной ключ — `strategy.name` (== identity.strategyName из intake, т.е. наш bundle.manifest.id).

Решение слайса: монитор ТЕРПИМ к «рана ещё нет» (ждёт до `maxWaitDays`, потом `paper.run_not_found` событие + stalled), а связка изолируется в порт:

```ts
interface PaperRunLocatorPort {
  // null пока ран не найден; found-once → runId фиксируется в ledger и локатор больше не зовётся
  locate(args: { strategyName: string; submittedAtMs: number }): Promise<{ runId: string; startedAtMs: number } | null>;
}
```

Единственный адаптер сейчас — эвристический над BotResultsReadPort: `listBotRuns({mode:'paper'})` → фильтр `strategy.name === strategyName && startedAtMs > submittedAtMs` → новейший по startedAtMs. Неоднозначность при переиспользовании strategyName реальна — митигируется фиксацией runId один раз + событием с выбранным runId (аудит).

**Параллельно платформе уходят два handoff-дока** (конвенция 2026-06-30-platform-close-reason-enum-handoff.md): (a) auto-start после promotion (watcher на bot_bundle или enqueue в host-реестр); (b) candidateId/bundleId на bot_run + в `/ops/runs`. Когда (b) приедет — меняется ТОЛЬКО адаптер локатора.

⚠️ Прецедент Feature 038: пользователь ранее предпочёл заблокироваться на платформенной фиче вместо урезанной версии. Отличие здесь: эвристика функционально корректна при уникальных strategyName (наши manifest.id уникальны на профиль), дизайн не меняется при апгрейде (шов-порт), и без G4 Цикл 2 не замкнут вообще. Если на ревью решишь «блок» — слайс сужается до PaperWindowPolicy+handoff-доков.

## 3. Адаптивная политика окна (§2.5, единица = сделки)

```ts
interface PaperWindowPolicy {
  minTrades: number;              // 30 (академический минимум §2.5)
  lowConfidenceThreshold: number; // 15
  minDays: number;                // 3  (даже high-freq наблюдаем не меньше)
  maxDays: number;                // 30 (кэп наблюдения)
  maxWaitDays: number;            // 7  (ждать появления рана после submit)
}
```

Дефолты — env (`PAPER_WINDOW_MIN_TRADES` и т.д.), хранится снапшотом на ledger-строке при старте мониторинга (эксперимент знает, как его наблюдали — как holdoutPolicy на research_experiment).

Чистая функция `evaluatePaperWindow(policy, {runStartedAtMs, nowMs, closedTrades})`:
- `elapsed < minDays` → `watching`;
- `closedTrades >= minTrades && elapsed >= minDays` → `window_complete` (confidence normal);
- `elapsed >= maxDays && closedTrades >= lowConfidenceThreshold` → `window_complete` (lowConfidence: true);
- `elapsed >= maxDays && closedTrades < lowConfidenceThreshold` → `stalled` (копим данные — Цикл 2 НЕ триггерим, событие `paper.window_stalled`; аналог INCONCLUSIVE ≠ FAIL);
- иначе `watching`.

## 4. `paper.monitor` — самопереставляющаяся задача

`'paper.monitor'` уже в AGENT_TASK_TYPES (reserved) — enum не меняется. `TaskQueuePort.enqueue` уже принимает `{delayMs}` (BullMQ delayed) — крон не нужен.

**Старт:** `paperStartHandler` при `ok:true && admissionStatus === 'admitted'` энкьюит `paper.monitor {experimentId}` с `delayMs = PAPER_MONITOR_POLL_MS` (дефолт 6ч; demo меньше), dedupeKey `paper.monitor:${experimentId}:0`.

**Handler `paperMonitorHandler`** (payload `{experimentId, attempt?: number}`):
1. Ledger-строка по experimentId обязана существовать со status `submitted` (иначе actionable error). `monitor_status ∈ {watching, window_complete, stalled}` — если уже терминальный, событие `paper.monitor.already_done`, выход.
2. Если `paper_run_id` ещё не зафиксирован: `locator.locate(...)` → null и `elapsed(submittedAt) > maxWaitDays` → `stalled` + `paper.run_not_found`; null и не истёк → re-enqueue себя (`attempt+1`, dedupeKey с attempt) и выход; found → зафиксировать `paper_run_id`+`run_started_at` в ledger + событие `paper.run_located {runId}`.
3. `botResults.getRunSummary(runId)` → `closedTrades` → `evaluatePaperWindow`:
   - `watching` → обновить `observed_trades` в ledger, re-enqueue с delayMs;
   - `window_complete` → ledger `monitor_status='window_complete'` (+lowConfidence flag) + событие `paper.window_complete {runId, closedTrades, lowConfidence}` + **enqueue `research.run_cycle {strategyProfileId}`** (source `platform`, correlationId task.correlationId, dedupeKey `paper_window:${runId}` — ровно один Цикл 2 на окно);
   - `stalled` → ledger + событие, БЕЗ триггера.
4. Kill-switch мониторинга не нужен: если paper-мост выключен (нет LAB_PAPER_INTAKE_URL), paper.monitor просто никогда не энкьюится (submitted-строк нет). Для чтения нужен `LAB_BOT_RESULTS_INTEGRATION=http` — при mock/fixture монитор честно работает по их данным (тестируемость).

**Ретраи:** сбой чтения ops-read → throw → BullMQ retry той же задачи (идемпотентна: чтение + upsert). Re-enqueue цепочка через attempt-нумерованный dedupeKey.

## 5. Ledger: аддитивные колонки на `paper_submission` (миграция 0017)

`paper_run_id text NULL`, `run_started_at_ms bigint NULL` (или timestamptz — как соседние), `monitor_status text NULL` (`watching|window_complete|stalled`), `observed_trades int NULL`, `window_policy jsonb NULL` (снапшот политики), `low_confidence boolean NULL`. Репозиторий: `updateMonitorState(experimentId, patch)` (+ port). Одна submission = один наблюдаемый ран — отдельная таблица не нужна (YAGNI).

## 6. Цикл 2 — что именно триггерится

`research.run_cycle {strategyProfileId}` — существующий handler: двухпроходный researcher уже читает bot-результаты (BotResultsReadPort, mode paper), per-trade forensic, active overlay rules; валидированные гипотезы → hypothesis.build → (cycleDepth 0) holdout-lane. НИЧЕГО в run_cycle не меняем — G4 только даёт ему вход и момент. Всегда триггерим при window_complete (researcher сам ищет и по убыточным, и по недобравшим — вердикта «paper плохой» не требуется); деградационный-триггер и canary (§3 roadmap GATE CANARY) — вне scope (G5).

## 7. Тесты (TDD)

1. `evaluatePaperWindow` — таблица кейсов по §3 (все 5 ветвей + границы minDays/maxDays/thresholds).
2. Локатор-эвристика: находит новейший matching ран; отбрасывает startedAt <= submittedAt; null при отсутствии; неоднозначность (2 рана) → новейший + факт выбора в результате.
3. `paperMonitorHandler`: run-not-yet → re-enqueue с delayMs+attempt; run located → ledger fixed + событие; watching → observed_trades обновлён + re-enqueue; window_complete → ledger+событие+enqueue research.run_cycle (payload/dedupeKey/source) ровно один раз (повторный monitor → already_done); stalled (maxDays, < threshold) → без триггера; maxWaitDays истёк → stalled + run_not_found; терминальная строка → already_done без чтений.
4. `paperStartHandler` extension: admitted → enqueue paper.monitor с delayMs; rejected/failed → НЕ энкьюит.
5. Репо: monitor-колонки round-trip; миграция 0017 аддитивна.
6. Интеграционный: submitted ledger + fake bot-results (paper ран с трейдами) → monitor → window_complete → run_cycle enqueued.

## 8. Рассмотренные альтернативы

- Внешний cron/office-триггер вместо self-rescheduling BullMQ delayed — лишняя инфраструктура, отклонено (delayMs уже есть в порте).
- Отдельная таблица paper_monitor — YAGNI, одна submission = один ран.
- Триггер Цикла 2 только при деградации — требует paper-вердикта/порогов, researcher и так двусторонний; отложено (данных paper ещё нет, пороги неоткуда калибровать).
- Блок на платформенные фичи (auto-start + candidateId→runId) — см. ⚠️ §2; решение за пользователем на ревью.

## 9. Риски

- Эвристика локатора при переиспользовании strategyName: манифест-id уникальны на профиль, но ре-сабмит того же профиля создаст второй ран с тем же именем — фиксация runId once + `startedAtMs > submittedAtMs` сужает окно коллизии до одновременных ранов одного имени; handoff (b) устраняет класс целиком.
- `PAPER_MONITOR_POLL_MS` дефолт 6ч — при рестарте Redis delayed-джобы BullMQ персистентны (Redis), но при ПОЛНОЙ потере Redis мониторинг молча обрывается; восстановление — batch-скан ledger-строк `monitor_status='watching'` (мелкий CLI `paper:monitor:resume` по образцу platform:resume — в scope слайса).
- run_started_at из эвристики (startedAtMs run-row) — источник окна; если хост рестартует и ран получает новый runId, окно начнётся заново (честно: новый ран = новые сделки; старые сделки старого runId потеряны для окна — задокументировано).
