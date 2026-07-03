# Slice G4 — paper.monitor: наблюдение paper-рана, адаптивное окно, автотриггер Цикла 2

**Date:** 2026-07-03
**Status:** APPROVED — ревью пользователя пройдено, 4 блокера исправлены (run_cycle paperRunId-вход вместо слепого finished-фильтра; delayMs в TaskIntakeInput; strategy_name в ledger 0017; ensureMonitorScheduled на retry-edge) + уточнения (сеяние watching-состояния до enqueue, resume-dedupeKey, env-валидация политики, closedTrades из summary, честный acceptance). «Толерантный монитор + handoff» подтверждён пользователем. Готово к writing-plans.
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

РЕШЕНО ревью пользователя: «толерантный монитор + handoff», НЕ блок; эвристический локатор допустим как временный адаптер. **Acceptance-критерий сформулирован честно:** lab-side G4 верифицируется на fake/fixture ops-read (unit+integration); **живой полный цикл до Цикла 2 зависит от платформенных handoff'ов** (auto-start после promotion; candidateId→runId) и в acceptance этого слайса НЕ входит.

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

`'paper.monitor'` уже в AGENT_TASK_TYPES (reserved) — enum не меняется. `TaskQueuePort.enqueue` уже принимает `{delayMs}` (BullMQ delayed) — крон не нужен. **Но `createAndEnqueueTask` (task-intake.ts:60) вызывает `queue.enqueue(envelope)` без opts** — в scope слайса: `TaskIntakeInput += delayMs?: number`, intake пробрасывает его в `queue.enqueue(envelope, {delayMs})` (in-memory адаптер задержку игнорирует — задокументировано там же).

**Старт:** `paperStartHandler` при `ok:true && admissionStatus === 'admitted'`:
1. Сразу сеет monitor-состояние в ledger-строку: `monitor_status='watching'`, `window_policy` (снапшот из env), `observed_trades=0`, `strategy_name` (= `args.identity.strategyName`, он же bundle.manifest.id — нужен локатору, из `{experimentId}` его иначе не восстановить) — ДО enqueue, чтобы resume-CLI видел свежие admitted-строки ещё до первого тика.
2. Энкьюит `paper.monitor {experimentId}` с `delayMs = PAPER_MONITOR_POLL_MS` (дефолт 6ч; demo меньше), dedupeKey `paper.monitor:${experimentId}:0`.

**Retry-edge (найдено на ревью):** guard «already submitted» из G2b больше НЕ просто выходит — для existing `submitted`-строки handler выполняет `ensureMonitorScheduled`: если `monitor_status` пуст или `watching` — досеять недостающие monitor-поля и энкьюить paper.monitor (иначе сценарий «submit записал ledger, enqueue монитора упал, retry увидел submitted и вышел» оставил бы ран ненаблюдаемым). Терминальные `monitor_status` — прежнее поведение (`paper.already_submitted`, выход).

**Handler `paperMonitorHandler`** (payload `{experimentId, attempt?: number}`):
1. Ledger-строка по experimentId обязана существовать со status `submitted` (иначе actionable error). `monitor_status ∈ {watching, window_complete, stalled}` — если уже терминальный, событие `paper.monitor.already_done`, выход.
2. Если `paper_run_id` ещё не зафиксирован: `locator.locate(...)` → null и `elapsed(submittedAt) > maxWaitDays` → `stalled` + `paper.run_not_found`; null и не истёк → re-enqueue себя (`attempt+1`, dedupeKey с attempt) и выход; found → зафиксировать `paper_run_id`+`run_started_at` в ledger + событие `paper.run_located {runId}`.
3. `botResults.getRunSummary(runId)` → `closedTrades` → `evaluatePaperWindow`:
   - `watching` → обновить `observed_trades` в ledger, re-enqueue с delayMs;
   - `window_complete` → ledger `monitor_status='window_complete'` (+lowConfidence flag) + событие `paper.window_complete {runId, closedTrades, lowConfidence}` + **enqueue `research.run_cycle {strategyProfileId, paperRunId}`** (source `platform`, correlationId task.correlationId, dedupeKey `paper_window:${runId}` — ровно один Цикл 2 на окно; paperRunId — тот самый зафиксированный ран, см. §6);
   - `stalled` → ledger + событие, БЕЗ триггера.
4. Kill-switch мониторинга не нужен: если paper-мост выключен (нет LAB_PAPER_INTAKE_URL), paper.monitor просто никогда не энкьюится (submitted-строк нет). Для чтения нужен `LAB_BOT_RESULTS_INTEGRATION=http` — при mock/fixture монитор честно работает по их данным (тестируемость).

**Ретраи:** сбой чтения ops-read → throw → BullMQ retry той же задачи (идемпотентна: чтение + upsert). Re-enqueue цепочка через attempt-нумерованный dedupeKey.

## 5. Ledger: аддитивные колонки на `paper_submission` (миграция 0017)

`strategy_name text NULL` (identity.strategyName — ключ локатора; NULL-able ради существующих строк, paperStartHandler всегда пишет), `paper_run_id text NULL`, `run_started_at_ms bigint NULL` (или timestamptz — как соседние), `monitor_status text NULL` (`watching|window_complete|stalled`), `observed_trades int NULL`, `window_policy jsonb NULL` (снапшот политики), `low_confidence boolean NULL`. Репозиторий: `updateMonitorState(experimentId, patch)` (+ port). Одна submission = один наблюдаемый ран — отдельная таблица не нужна (YAGNI).

**Env-валидация политики** (при composition, fail-fast на мусор): все значения positive int; `lowConfidenceThreshold <= minTrades`; `minDays <= maxDays`; `maxWaitDays >= 1`. `closedTrades` монитор берёт из `getRunSummary(runId).closedTrades` (поле существует в RunSummary — подтверждено).

## 6. Цикл 2 — что именно триггерится (И ОДНА ПРАВКА В run_cycle)

`research.run_cycle` — существующий handler, НО с одной прицельной правкой (найдено на ревью): сегодня он читает `listBotRuns({ status: 'finished' })` (research-run-cycle.handler.ts:173), а наш paper-ран по построению НЕ finished (ран не завершается сам, окно — lab-side решение посреди running). Без правки Цикл 2 просто не увидел бы данные, ради которых запущен.

**Фикс: payload-расширение, а не смена глобального фильтра.** `research.run_cycle` payload += `paperRunId?: string`. Когда поле присутствует, handler ДОПОЛНИТЕЛЬНО к существующему finished-списку загружает именно этот ран (`getRunSummary(paperRunId)` + `getClosedTrades(paperRunId)`) НЕЗАВИСИМО от status и включает его в researcher-вход (bot results digest + suspicious/winner trade selection). Существующее поведение всех остальных вызовов run_cycle не меняется. `paper.monitor` при триггере передаёт `{strategyProfileId, paperRunId}`.

Всегда триггерим при window_complete (researcher двухпроходный — вердикта «paper плохой» не требуется); деградационный-триггер и canary (§3 roadmap GATE CANARY) — вне scope (G5).

## 7. Тесты (TDD)

1. `evaluatePaperWindow` — таблица кейсов по §3 (все 5 ветвей + границы minDays/maxDays/thresholds).
2. Локатор-эвристика: находит новейший matching ран; отбрасывает startedAt <= submittedAt; null при отсутствии; неоднозначность (2 рана) → новейший + факт выбора в результате.
3. `paperMonitorHandler`: run-not-yet → re-enqueue с delayMs+attempt; run located → ledger fixed + событие; watching → observed_trades обновлён + re-enqueue; window_complete → ledger+событие+enqueue research.run_cycle (payload/dedupeKey/source) ровно один раз (повторный monitor → already_done); stalled (maxDays, < threshold) → без триггера; maxWaitDays истёк → stalled + run_not_found; терминальная строка → already_done без чтений.
4. `paperStartHandler` extension: admitted → сеет watching-состояние (strategy_name, policy snapshot, observed_trades=0) И энкьюит paper.monitor с delayMs; rejected/failed → НЕ энкьюит; **retry-edge**: existing submitted-строка с monitor_status NULL/watching → ensureMonitorScheduled (досев + enqueue), терминальная → already_submitted.
5. `createAndEnqueueTask` delayMs-проброс: opts доходит до queue.enqueue (fake queue записывает delayMs); без delayMs — прежнее поведение.
6. `research.run_cycle` + paperRunId: ран с указанным id загружается независимо от status и попадает в researcher-вход; без paperRunId — прежний finished-фильтр байт-в-байт.
7. Env-валидация политики: каждый инвариант (positive, lowConfidence<=minTrades, minDays<=maxDays, maxWaitDays>=1) fail-fast.
8. Репо: monitor-колонки round-trip; миграция 0017 аддитивна.
9. Интеграционный: submitted ledger + fake bot-results (paper ран с трейдами) → monitor → window_complete → run_cycle enqueued с {strategyProfileId, paperRunId}.
10. resume-CLI: watching-строки → новые monitor-задачи с resume-dedupeKey; двойной запуск в одну минуту → dedupe.

## 8. Рассмотренные альтернативы

- Внешний cron/office-триггер вместо self-rescheduling BullMQ delayed — лишняя инфраструктура, отклонено (delayMs уже есть в порте).
- Отдельная таблица paper_monitor — YAGNI, одна submission = один ран.
- Триггер Цикла 2 только при деградации — требует paper-вердикта/порогов, researcher и так двусторонний; отложено (данных paper ещё нет, пороги неоткуда калибровать).
- Блок на платформенные фичи (auto-start + candidateId→runId) — см. ⚠️ §2; решение за пользователем на ревью.

## 9. Риски

- Эвристика локатора при переиспользовании strategyName: манифест-id уникальны на профиль, но ре-сабмит того же профиля создаст второй ран с тем же именем — фиксация runId once + `startedAtMs > submittedAtMs` сужает окно коллизии до одновременных ранов одного имени; handoff (b) устраняет класс целиком.
- `PAPER_MONITOR_POLL_MS` дефолт 6ч — при рестарте Redis delayed-джобы BullMQ персистентны (Redis), но при ПОЛНОЙ потере Redis мониторинг молча обрывается; восстановление — batch-скан ledger-строк `monitor_status='watching'` (мелкий CLI `paper:monitor:resume` по образцу platform:resume — в scope слайса). **Нюанс dedupe (найден на ревью):** resume НЕ может переиспользовать dedupeKey уже созданной delayed-задачи — `createAndEnqueueTask` вернёт existing DB-task и НЕ положит job в Redis. Resume-CLI генерит новый attempt-номер: читает максимальный использованный attempt невозможно дёшево → используем время: dedupeKey `paper.monitor:${experimentId}:resume-${YYYYMMDDHHmm}` (минутная гранулярность защищает от двойного запуска CLI; strategy_name и всё нужное — из ledger-строки).
- run_started_at из эвристики (startedAtMs run-row) — источник окна; если хост рестартует и ран получает новый runId, окно начнётся заново (честно: новый ран = новые сделки; старые сделки старого runId потеряны для окна — задокументировано).
