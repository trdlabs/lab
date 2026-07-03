# Slice G2b — Paper-bridge orchestration: WFO champion → platform intake

**Date:** 2026-07-03
**Status:** DESIGN — ждёт ревью пользователя. Принятые ранее решения: авто-триггер + kill-switch (подтверждено пользователем); охват = только WFO-лейн (рекомендованный дефолт, пользователь был AFK); координация: эта сессия берёт оркестрацию, PR #127 (порт+CLI) НЕ трогается — только потребляется (пользователь был AFK; основание — шапка CLI #127 явно оставляет оркестрацию оркестратору).
**Parent:** roadmap §8 гап G2; поверх PR #127 (`PaperIntakePort` + `submit-paper-candidate.mts`, живой e2e против платформы пройден) и PR #125 (G1).

## 1. Цель

Замкнуть Цикл 1 автоматикой: WFO-эксперимент с вердиктом `PAPER_CANDIDATE` сам отправляет чемпиона (бандл + champion-params + evidence) в платформенный intake (фича 036/066), фиксирует результат допуска в lab-ledger и излучает события. Ручной путь (CLI из #127) остаётся как ops-инструмент.

Вне scope: гипотезный лейн (после G3), мониторинг paper-РЕЗУЛЬТАТОВ и триггер Цикла 2 (G4), HITL-подтверждение (после Telegram/push-канала), правки `paper-intake.port.ts`.

## 2. Триггер: task type `paper.start`

`'paper.start'` уже зарезервирован в `AGENT_TASK_TYPES` — enum не меняется. `strategyWfoHandler` после `runWalkForwardOptimization` при `verdict === 'PAPER_CANDIDATE'` энкьюит `paper.start` `{experimentId}` (тем же `correlationId`, dedupeKey `paper.start:${experimentId}`) — зеркально baseline→wfo цепочке G1. Сетевой сабмит изолирован в собственной retryable-задаче.

Новый handler `paperStartHandler` (`src/orchestrator/handlers/paper-start.handler.ts`):
1. Payload `{experimentId}` (schema-gated). Эксперимент обязан быть `walk_forward_optimization` с verdict `PAPER_CANDIDATE` — иначе actionable error.
2. `selectPaperIntake(env)` из #127: `enabled === false` → событие `paper.intake_skipped {reason:'intake_disabled'}` + штатное завершение (kill-switch = отсутствие `LAB_PAPER_INTAKE_URL`, как выбран пользователем).
3. Идемпотентность (lab-сторона): если в `paper_submission` уже есть строка по `experimentId` со статусом `admitted|quarantined` — событие `paper.already_submitted`, завершение (интейк-сторона дополнительно дедупит по `idempotencyKey`).
4. Байты чемпиона в CAS (§4) → evidence-маппинг (§3) → `port.submitProvenCandidate(...)` → запись ledger-строки (§5) + событие `paper.candidate_submitted {candidateId, admissionStatus}` (или `paper.candidate_rejected` при `ok:false` / `admissionStatus:'rejected'` — задача НЕ фейлится: reject — валидный исход, не ошибка транспорта; транспортная ошибка (`ok:false` c category `internal_error`/сетевая) — throw → retry).

## 3. Evidence-маппинг: чистая функция `buildChampionSubmission`

`src/research/champion-evidence.ts` — pure, тестируется без сети:

Вход: WFO-эксперимент + его members + baseline-эксперимент + его members + StrategyProfile.
Выход: `SubmitProvenCandidateArgs` (тип из #127).

- `bundle.bundleHash` = WFO `experiment.bundleHash` (== baseline bundleHash по G1-guard).
- `identity.strategyName` = profile-идентификатор (точный источник определить на этапе плана: `profile.name` / manifest id); `identity.side` — из профиля (направление стратегии; long_oi → 'long'); `identity.params` = champion params = `params` holdout-member'а WFO (роль `holdout`, `oos: true`).
- `evidence.baselineRunId` = `strategyBacktestRunId` holdout-member'а baseline-эксперимента; `variantRunId` = holdout-member'а WFO.
- `evidence.metricsSnapshot` = метрики WFO holdout-прогона (из `StrategyBacktestRunRepository.findById`) + `resultSummary` member'а; `comparisonSnapshot` не заполняем (интейк-поле опционально).
- `evidence.datasetRef/symbols/timeframe` = `experiment.datasetScope`; `window.fromMs/toMs` = `Date.parse(datasetScope.period.from/.to)`.
- `evidence.improvementSummary` = `experiment.verdictReason ?? 'wfo champion'`; `riskNotes` — флаги из evaluation (`lowConfidenceHoldout` и т.п.), если доступны.
- `idempotencyKey` = `wfo-champion:${experimentId}` (стабильный: ретрай задачи → идемпотентный replay в интейке).
- `workflowId` = experimentId, `correlationId` = task.correlationId.

Отсутствие любого обязательного куска (нет holdout-member'а, нет run-метрик, нет baseline-эксперимента) → fail-fast с именем недостающего.

## 4. Байты чемпиона в content-addressed store

Промоция платформы (066) читает файл `INTAKE_PROMOTION_ARTIFACTS_DIR/<sha256hex>` и ре-верифицирует sha256 байтов. Наш G1-артефакт — JSON-обёртка `{source,manifest,bundleHash}`; её собственный hash ≠ `bundleHash`. Поэтому `paperStartHandler` обязан материализовать **каноничную байт-форму** бандла (ту, чей sha256 == `bundleHash`):

`reconstructStrategyBundle(artifacts, baseline.bundleArtifactRef)` → взять из `AssembledStrategyBundle` компилированные байты (точное поле — на этапе плана: то, над чем `computeBundleHash` считает hash) → `artifacts.put(bytes, {kind:'strategy_bundle_bytes', ...})`. Инвариант, проверяемый тестом: `put` возвращает ref с `content_hash === bundleHash` (LocalFileArtifactStore content-addressed → файл ложится в `.artifacts/<hex>` — ровно куда смотрит платформа). Если store именует иначе — выяснить на плане и, при необходимости, писать файл `<hex>` явно рядом (решение план-тайм, spec фиксирует только инвариант «после задачи файл с именем hex(bundleHash) и байтами бандла существует в артефакт-каталоге»).

## 5. Lab-ledger: таблица `paper_submission`

Аддитивная миграция (следующий номер по main): `paper_submission` (id text PK, experiment_id text NOT NULL, strategy_profile_id text NOT NULL, candidate_id text NULL, admission_status text NULL, idempotency_key text NOT NULL UNIQUE, bundle_hash text NOT NULL, params jsonb NULL, created_at/updated_at timestamptz). Порт `PaperSubmissionRepository` (create/findByExperimentId/updateStatus) + drizzle/in-memory адаптеры. Интейк отвечает `admissionStatus` синхронно — строка пишется сразу с итогом; поздние переходы (superseded и т.д.) — вне scope (будущий `paper.monitor`).

## 6. Тесты (TDD)

1. `buildChampionSubmission`: happy path (все поля из фикстурных экспериментов/member'ов), fail-fast на каждый отсутствующий кусок, идемпотентный ключ стабилен.
2. `paperStartHandler`: disabled-порт → skipped-событие, без сабмита; happy path с fake `PaperIntakePort` — байты в fake-store (content_hash == bundleHash), ledger-строка, событие с candidateId; повторный запуск → `paper.already_submitted`, порт не вызван; `admissionStatus:'rejected'` → rejected-событие, задача НЕ фейлится, ledger-строка со статусом; транспортная ошибка → throw (retry-путь), ledger-строки нет.
3. `strategyWfoHandler`: PAPER_CANDIDATE → enqueue `paper.start` (payload/dedupeKey/correlationId); другие вердикты → не энкьюит.
4. Репо: paper_submission round-trip (in-memory), миграция аддитивна.
5. Интеграционный: wfo(PAPER_CANDIDATE, fake-агенты) → paper.start → fake-порт → ledger+события, на in-memory инфраструктуре.

## 7. Рассмотренные альтернативы

- Инлайн-сабмит в `strategyWfoHandler` (без paper.start): проще, но сетевой вызов в конце длинной WFO-задачи — ретрай задачи повторил бы весь WFO; отклонено.
- Отдельный boolean `PAPER_INTAKE_ENABLED`: избыточен — `LAB_PAPER_INTAKE_URL`-отсутствие уже даёт boot-safe kill-switch из #127; отклонено.
- Ledger в experiment row (без новой таблицы): жизненный цикл кандидата ≠ жизненный цикл эксперимента (supersede, повторные сабмиты после re-run) — отклонено.
- Немедленный HITL в чате: нет push-канала из воркера в чат-сессию; отложено (после Telegram).

## 8. Риски

- Точная байт-форма бандла (поле AssembledStrategyBundle, над которым считается `computeBundleHash`) и именование файлов в LocalFileArtifactStore — два verify-at-plan пункта (§4); live e2e #127 подтверждает контракт платформы, но лабораторная механика материализации — новая.
- `identity.side`/`strategyName` из профиля — источник уточняется на плане; неверный side → незапускаемый bot_bundle (платформа проецирует только long|short).
- Параллельная сессия: порт не трогаем; если она начнёт свою оркестрацию — конфликт по новым файлам маловероятен, по strategy-wfo.handler возможен; координация через пользователя.
