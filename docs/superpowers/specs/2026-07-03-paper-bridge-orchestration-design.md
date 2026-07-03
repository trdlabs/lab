# Slice G2b — Paper-bridge orchestration: WFO champion → platform intake

**Date:** 2026-07-03
**Status:** APPROVED — 4 правки ревью пользователя внесены («после этих правок спека будет ок»); охват WFO-only и kill-switch через отсутствие `LAB_PAPER_INTAKE_URL` подтверждены пользователем; координация подтверждена обеими сторонами (notes SDK-релиза: «вызов порта из sweep-оркестратора — независим от нас, не дублируем»). Готово к writing-plans.
**Parent:** roadmap §8 гап G2; поверх PR #127 (`PaperIntakePort` + `submit-paper-candidate.mts`, живой e2e против платформы пройден), PR #128 (SDK 0.9.1: нативные identity-типы `strategyName/side/params` в `PaperCandidateStrategyInput`, локальный каст снят) и PR #125 (G1).
**Ревью пользователя (2026-07-03) применено:** baselineExperimentId в payload, platformRunId в evidence, DI порта через AppServices, точная байт-механика §4, декомпозиция ok:false + расширенный ledger.
**Контрактные нюансы платформы (из notes SDK-релиза):** `side` — только `long|short`; `moduleRef: null` + `moduleBundleHash` обязательно (иначе artifact-ref уйдёт по имени вместо хеша — порт #127 это уже соблюдает).

## 1. Цель

Замкнуть Цикл 1 автоматикой: WFO-эксперимент с вердиктом `PAPER_CANDIDATE` сам отправляет чемпиона (бандл + champion-params + evidence) в платформенный intake (фича 036/066), фиксирует результат допуска в lab-ledger и излучает события. Ручной путь (CLI из #127) остаётся как ops-инструмент.

Вне scope: гипотезный лейн (после G3), мониторинг paper-РЕЗУЛЬТАТОВ и триггер Цикла 2 (G4), HITL-подтверждение (после Telegram/push-канала), правки `paper-intake.port.ts`.

## 2. Триггер: task type `paper.start`

`'paper.start'` уже зарезервирован в `AGENT_TASK_TYPES` — enum не меняется. `strategyWfoHandler` после `runWalkForwardOptimization` при `verdict === 'PAPER_CANDIDATE'` энкьюит `paper.start` `{experimentId, baselineExperimentId}` (baselineExperimentId у wfo-хендлера уже в payload; из WFO-эксперимента его надёжно не восстановить — `computeWfoExperimentKey` opaque, parent-ссылки в `research_experiment` нет). Тот же `correlationId`, dedupeKey `paper.start:${experimentId}` — зеркально baseline→wfo цепочке G1. Сетевой сабмит изолирован в собственной retryable-задаче.

**DI:** `composition.ts` вносит `paperIntake: selectPaperIntake(process.env)` в `AppServices` (`AppServices.paperIntake: PaperIntakePort`); handler получает порт из `services`, НЕ читает env сам — тестируется fake-портом как остальные handlers.

Новый handler `paperStartHandler` (`src/orchestrator/handlers/paper-start.handler.ts`):
1. Payload `{experimentId: string, baselineExperimentId: string}` (schema-gated). Эксперимент обязан быть `walk_forward_optimization` с verdict `PAPER_CANDIDATE`; baseline-эксперимент обязан существовать и `wfo.bundleHash === baseline.bundleHash` — иначе actionable error.
2. `services.paperIntake.enabled === false` → событие `paper.intake_skipped {reason:'intake_disabled'}` + штатное завершение, ledger-строка НЕ пишется (kill-switch = отсутствие `LAB_PAPER_INTAKE_URL`, как выбран пользователем).
3. Идемпотентность (lab-сторона): если в `paper_submission` уже есть строка по `experimentId` с `submission_status='submitted'` — событие `paper.already_submitted`, завершение без вызова порта (интейк-сторона дополнительно дедупит по `idempotencyKey`; строка `failed`/`rejected` НЕ блокирует повторную попытку — см. §5 про upsert).
4. Байты чемпиона в CAS (§4) → evidence-маппинг (§3) → `services.paperIntake.submitProvenCandidate(...)` → **разбор результата**:
   - `ok:true` → ledger `submission_status='submitted'`, `admission_status`/`admission_reason_code` из ответа + событие `paper.candidate_submitted {candidateId, admissionStatus}`; при `admissionStatus==='rejected'` — дополнительно `paper.candidate_rejected` (задача НЕ фейлится: reject — валидный исход допуска).
   - `ok:false`, `error.category === 'internal_error'` ИЛИ сетевой throw транспорта → **throw** → задача ретраится (ledger-строка не пишется).
   - `ok:false`, `error.category ∈ {validation_error, not_found, conflict, unsupported_query}` → терминальный не-retry исход: ledger `submission_status='failed'` + `error` jsonb + событие `paper.submission_failed {category, code}`; задача завершается штатно (ретрай не поможет — вход детерминированно отвергнут).

## 3. Evidence-маппинг: чистая функция `buildChampionSubmission`

`src/research/champion-evidence.ts` — pure, тестируется без сети:

Вход: WFO-эксперимент + его members + baseline-эксперимент + его members + StrategyProfile + **обе run-строки** (`StrategyBacktestRun`).
Выход: `SubmitProvenCandidateArgs` (тип из #127; SDK 0.9.1 типизирует identity нативно).

- `bundle.bundleHash` = WFO `experiment.bundleHash` (== baseline bundleHash — handler это провалидировал, §2).
- `identity.strategyName` = profile-идентификатор (точный источник определить на этапе плана: `profile.name` / manifest id); `identity.side` — из профиля (направление стратегии; long_oi → 'long'; платформа принимает ТОЛЬКО long|short); `identity.params` = champion params = `params` holdout-member'а WFO (роль `holdout`, `oos: true`).
- **Run ids — платформенные, не lab-овские:** member даёт lab id только для lookup — `strategyBacktests.findById(member.strategyBacktestRunId)` → `evidence.baselineRunId = baselineRun.platformRunId`, `evidence.variantRunId = variantRun.platformRunId` (lab DB id ничего не значит для платформы — тот же нюанс, что в trades-flow).
- `evidence.metricsSnapshot` = метрики из тех же run-строк (variantRun.metrics) + `resultSummary` member'а; `comparisonSnapshot` не заполняем (интейк-поле опционально).
- `evidence.datasetRef/symbols/timeframe` = `experiment.datasetScope`; `window.fromMs/toMs` = `Date.parse(datasetScope.period.from/.to)`.
- `evidence.improvementSummary` = `experiment.verdictReason ?? 'wfo champion'`; `riskNotes` — флаги из evaluation (`lowConfidenceHoldout` и т.п.), если доступны.
- `idempotencyKey` = `wfo-champion:${experimentId}` (стабильный: ретрай задачи → идемпотентный replay в интейке).
- `workflowId` = experimentId, `correlationId` = task.correlationId.

Отсутствие любого обязательного куска (нет holdout-member'а, нет run-метрик, нет baseline-эксперимента) → fail-fast с именем недостающего.

## 4. Байты чемпиона в content-addressed store

Промоция платформы (066) читает файл `INTAKE_PROMOTION_ARTIFACTS_DIR/<sha256hex>` и ре-верифицирует sha256 байтов. Наш G1-артефакт — JSON-обёртка `{source,manifest,bundleHash}`; её собственный hash ≠ `bundleHash`. Механика точная (проверено по коду, план-тайм неопределённости нет):

- `AssembledStrategyBundle.bytes: Uint8Array` — esbuild-выход, `bundleHash = computeBundleHash(bytes)` (src/domain/strategy-bundle.ts).
- `LocalFileArtifactStore.put(bytes, ...)` пишет content-addressed `.artifacts/<sha256hex>`.

`paperStartHandler`: `const bundle = await reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef)` → `const bytesRef = await services.artifacts.put(Buffer.from(bundle.bytes), { kind: 'strategy_bundle_bytes', mime_type: 'application/javascript', producer: 'paper-start-handler' })` → **assert `bytesRef.content_hash === bundle.bundleHash`** (fail-fast при рассинхроне store-хеширования). Файл `<hex(bundleHash)>` оказывается ровно там, откуда платформа заберёт его при промоции.

## 5. Lab-ledger: таблица `paper_submission`

Аддитивная миграция (следующий номер по main): `paper_submission` (id text PK, **experiment_id text NOT NULL UNIQUE** («один champion-сабмишен на WFO-эксперимент» — findByExperimentId это и подразумевает), strategy_profile_id text NOT NULL, **submission_status text NOT NULL** (`submitted | rejected | failed`), candidate_id text NULL, admission_status text NULL, **admission_reason_code text NULL**, **error jsonb NULL** (категория/код/сообщение при терминальном `failed`), idempotency_key text NOT NULL UNIQUE, bundle_hash text NOT NULL, params jsonb NULL, created_at/updated_at timestamptz).

Семантика статусов: `submitted` — интейк принял запрос (`ok:true`; допуск в `admission_status`, включая `rejected` со стороны допуска — тогда submission_status='rejected'); `failed` — терминальный не-retry исход `ok:false` (validation_error/not_found/conflict/unsupported_query). `skipped` строкой НЕ фиксируется — disabled-порт даёт только событие (нечего вести в ledger'е, пока сабмита не было). Повторная попытка по эксперименту со строкой `failed`/`rejected` — **upsert той же строки** (experiment_id UNIQUE), новая — только при отсутствии.

Порт `PaperSubmissionRepository` (upsertByExperimentId/findByExperimentId) + drizzle/in-memory адаптеры. Интейк отвечает `admissionStatus` синхронно — строка пишется сразу с итогом; поздние переходы (superseded и т.д.) — вне scope (будущий `paper.monitor`).

## 6. Тесты (TDD)

1. `buildChampionSubmission`: happy path (все поля из фикстурных экспериментов/member'ов/run-строк; **run ids = platformRunId, не lab id**), fail-fast на каждый отсутствующий кусок (member, run-строка, профиль), идемпотентный ключ стабилен.
2. `paperStartHandler` (fake `services.paperIntake`, DI через AppServices): disabled-порт → skipped-событие, без сабмита и без ledger-строки; happy path — байты в fake-store (`content_hash === bundleHash`), ledger `submitted`, событие с candidateId; повторный запуск при `submitted` → `paper.already_submitted`, порт не вызван; bundleHash mismatch wfo↔baseline → actionable error; `ok:true, admissionStatus:'rejected'` → rejected-событие + ledger `rejected`, задача НЕ фейлится; `ok:false, internal_error` → throw (retry), ledger-строки нет; `ok:false, validation_error` → ledger `failed` + error jsonb + `paper.submission_failed`, задача завершается штатно; retry после `failed` → upsert той же строки.
3. `strategyWfoHandler`: PAPER_CANDIDATE → enqueue `paper.start` `{experimentId, baselineExperimentId}` (payload/dedupeKey/correlationId); другие вердикты → не энкьюит.
4. Репо: paper_submission round-trip (in-memory), миграция аддитивна.
5. Интеграционный: wfo(PAPER_CANDIDATE, fake-агенты) → paper.start → fake-порт → ledger+события, на in-memory инфраструктуре.

## 7. Рассмотренные альтернативы

- Инлайн-сабмит в `strategyWfoHandler` (без paper.start): проще, но сетевой вызов в конце длинной WFO-задачи — ретрай задачи повторил бы весь WFO; отклонено.
- Отдельный boolean `PAPER_INTAKE_ENABLED`: избыточен — `LAB_PAPER_INTAKE_URL`-отсутствие уже даёт boot-safe kill-switch из #127; отклонено.
- Ledger в experiment row (без новой таблицы): жизненный цикл кандидата ≠ жизненный цикл эксперимента (supersede, повторные сабмиты после re-run) — отклонено.
- Немедленный HITL в чате: нет push-канала из воркера в чат-сессию; отложено (после Telegram).

## 8. Риски

- ~~Байт-форма бандла~~ — снято ревью: `bytes`/`computeBundleHash(bytes)`/content-addressed store проверены по коду (§4); остаточный риск закрыт assert'ом `content_hash === bundleHash`.
- `identity.side`/`strategyName` из профиля — источник уточняется на плане; неверный side → незапускаемый bot_bundle (платформа проецирует только long|short).
- Параллельная сессия: порт не трогаем; если она начнёт свою оркестрацию — конфликт по новым файлам маловероятен, по strategy-wfo.handler возможен; координация через пользователя.
