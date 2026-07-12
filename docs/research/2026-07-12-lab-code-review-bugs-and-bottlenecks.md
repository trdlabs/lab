# Lab code review — баги, недоработки, узкие места

**Дата:** 2026-07-12
**База:** ветка `feat/r1-cycle2-loop-closure` @ `49009ed` (= main после merge PR #150)
**Метод:** механический скан графа (gortex: dead_code / hotspots / cycles / sast / contracts / health_score) + шесть параллельных ревью по подсистемам (оркестратор, revision-lane, БД-слой, platform-граница, chat/operator, config/composition). Критичные находки точечно верифицированы по исходникам. Код не изменялся.

---

## Сводка

Архитектурная дисциплина репозитория высокая: auth-границы в основном fail-closed, evidence-цепочка 079 корректна, атомарный confirm в чате, resumeToken делает replay сабмита идемпотентным. Механический скан почти пуст: dead code — 1 символ, серьёзных циклов нет, contracts без orphan'ов.

Главная проблема — **надёжность конвейера задач**: у петли Цикла 2 есть несколько режимов «тихого перманентного клина» (wedge), которые срабатывают уже при `LAB_QUEUE_CONCURRENCY=1`, и как минимум два подтверждённых механизма гонки, которые не дадут поднять конкурентность без исправлений. Вторая системная тема — **fail-open по умолчанию** в конфигурации и на границах: опечатка в env тихо подменяет прод-адаптер заглушкой, Docker-компоуз молча роняет десятки переменных, ошибки инфраструктуры маскируются под бизнес-исходы.

Приоритеты: **P0** — чинить до следующего длинного прогона; **P1** — реальные латентные баги; **P2** — гигиена/удаления; **P3** — узкие места и рефактор-цели; **P4** — бэклог.

---

## P0 — Критичные: перманентные клины петли и падения процесса

### P0-1. Zero-fire гонка триггера закрытия цикла — главный блокер `LAB_QUEUE_CONCURRENCY > 1`
`src/orchestrator/handlers/backtest-completed.handler.ts:199-215`

Триггер `revision.build` — неатомарная проверка `others.every(t => terminal)`, где каждая задача исключает только *себя*, а статус `completed` проставляется воркером **после** возврата хэндлера (`src/worker/worker.ts:22-23`). При конкурентности ≥ 2 два последних `backtest.completed` цикла видят друг друга в `running` → **оба** решают «цепочка не терминальна» → `revision.build` не enqueue'ится никогда. Комментарий про dedupeKey закрывает только double-fire, не zero-fire.

**Фикс:** атомарный DB-side claim (условный `UPDATE`/счётчик незавершённых по correlationId в одной транзакции), либо всегда enqueue'ить `revision.build` с dedupeKey и внутри него перепроверять терминальность цепочки с self-requeue.

### P0-2. Триггер закрытия цикла теряется, если последней терминализируется не-`backtest.completed` задача
`backtest-completed.handler.ts:199-215` + `src/orchestrator/handlers/hypothesis-build.handler.ts:279-333`

Триггер живёт только в `backtestCompletedHandler`, но у `hypothesis.build` есть терминальные выходы без порождения `backtest.completed`: `missing_platform_run_config`, `builder_failed`, невалидный бандл, `backtest.reused`, `datasets_unavailable`, throw после 3 попыток. Сценарий (воспроизводим при concurrency=1): `backtest.completed` гипотезы H1 отрабатывает, пока `hypothesis.build` H2 ещё `running` → триггер не сработал; затем H2 падает → `backtest.completed` для этой корреляции больше не будет → `revision.build` не создаётся, `proxy_passed`-гипотезы H1 осиротели навсегда (Step-2 scoping в `revision-build.handler.ts` не подметает чужие корреляции).

**Фикс:** проверять «цепочка терминальна?» на каждом терминальном выходе `hypothesis.build` (или централизованно в воркере после терминализации любой задачи цепочки).

### P0-3. `revision.build` неидемпотентен под retry: краш после create навсегда клинит lane профиля под ложным `concurrent_revision`
`src/orchestrator/handlers/revision-build.handler.ts:262-270` (create + catch), `:299/:332` (ран-экзекьютор), `src/db/schema.ts` (`strategy_revision_profile_version_uq`)

После `revisions.create` (версия = `accepted.version + 1`) остаются долгие await'ы (до 3 бэктест-ранов, фетчи трейдов). Throw → BullMQ retry → та же версия → unique violation → catch репортит `revision.skipped: concurrent_revision` и возвращается «успешно». Итог: строка первой попытки застревает в `candidate` навсегда, её никто не терминализирует, `findLatestAccepted` смотрит только на `accepted` → каждый следующий цикл снова считает версию N+1, бьётся об индекс и скипается. Lane профиля мёртв до ручной правки БД; в ledger — ложная причина.

**Фикс:** в catch по unique violation загружать существующую строку `(profileId, version)`: если это свой `candidate` — резюмировать/терминализировать; плюс sweep протухших `candidate` (TTL → `rejected: 'abandoned'`).

### P0-4. Run-executor ресабмитит застрявший `submitted`-ран: orphan-ран на платформе + throw, детонирующий P0-3
`src/research/backtester-revision-run-executor.ts:53-64, 83-107`, `src/db/schema.ts` (`strategy_backtest_run_idem_uq`)

Dedup переиспользует только `completed`-строки. Ран, чей ограниченный полл вернул `pending`, остаётся `submitted` навсегда (resume-хэндлеры покрывают только hypothesis-lane). Следующий `execute` с той же identity `(strategyBundleId, paramsHash, bundleHash)` промахивается мимо dedup, сабмитит **новый** платформенный ран и падает на unique-индексе в `createSubmitted` — уже после принятия рана платформой. Особо горячая ячейка — `comparison_baseline` (identity разделяется всеми будущими ревизиями профиля): один таймаут базлайна в цикле K = клин всех циклов K+n плюс дубликат-ран на платформе на каждую попытку.

**Фикс:** для существующей не-completed строки — poll/resume по её `platformRunId`/`resumeToken` вместо ресабмита; ловить unique violation в `createSubmitted` с fallback на строку-победителя.

### P0-5. `paper.monitor`: одна транзиентная ошибка платформы навсегда убивает многонедельное наблюдение; revival-путь инертен
`src/orchestrator/handlers/paper-monitor.handler.ts:51,67`, `src/orchestrator/handlers/paper-start.handler.ts:138-145, 269`

Следующий tick планируется только на успешных путях. Throw из `locate`/`getRunSummary` → 3 ретрая BullMQ за ~3 секунды → задача `failed`, attempt N+1 не создаётся: submission висит в `monitorStatus: 'watching'` при кадансе полла 6 часов — 3-секундный сбой платформы убивает наблюдение целиком. Задокументированный revival (`ensureMonitorScheduled`, dedupeKey `paper.monitor:${experimentId}:0`) — no-op: этот ключ уже сожжён completed-строкой attempt-0 при первом сабмите, `createAndEnqueueTask` вернёт `deduped: true`, ничего не enqueue'ив.

**Фикс:** try/catch вокруг тела полла с reschedule attempt+1 на транзиентных ошибках (терминалить только по policy expiry); revival-ключ сделать epoch-scoped (revivalCount на submission).

### P0-6. pg-notify стрим: утечка коннектов пула + возврат мёртвого клиента → зависает вся работа с БД
`src/adapters/read/pg-notify-agent-event-stream.ts:45-60`

Подтверждено по коду: (a) если `LISTEN` бросил (типично в окно рестарта Postgres), выданный `pool.connect()`-клиент не release'ится никогда (`this.client` присваивается после LISTEN), а `.catch(() => this.reconnect())` ретраит каждую секунду — минус один коннект за попытку до исчерпания `LAB_PG_POOL_MAX` (default 10), после чего **все** Drizzle-запросы приложения виснут; (b) `reconnect()` делает `this.client?.release()` без error-аргумента — сломанный сокет возвращается в пул живым, следующий запрос получает «труп»; (c) `'error'` может прийти повторно, guard'а «reconnect уже в полёте» нет — параллельные цепочки connect плодят LISTEN-клиентов, из которых сохраняется только последний.

**Фикс:** try/catch вокруг LISTEN с `client.release(err)`; `release(true)` в reconnect; флаг in-flight reconnect.

### P0-7. Нет `pool.on('error')` и глобальных обработчиков: idle-ошибка пула роняет процесс, рестарта нет
`src/db/client.ts:7-11`, `src/composition.ts:338`; grep по `src/` подтверждает ноль `pool.on / unhandledRejection / uncaughtException`

`pg.Pool` эмитит `'error'` на idle-клиентах (рестарт бэкенда, сетевой блип, WSL2/Docker). EventEmitter без слушателя = uncaught exception = смерть процесса; base/local/demo compose имеют `restart: "no"` — ingress/worker лежат до ручного подъёма. Любой stray unhandled rejection (напр. fire-and-forget reschedule монитора) — то же самое.

**Фикс:** `pool.on('error', log)` в `createDbClient`; `process.on('unhandledRejection'/'uncaughtException')` с логом и вызовом существующего `shutdown()`; `restart: unless-stopped` вне dev.

---

## P1 — Реальные латентные баги

### Конвейер и очередь

- **P1-1. `task-intake`: create+enqueue без транзакции и без reconciliation; dedupeKey делает потерю перманентной** — `src/orchestrator/task-intake.ts:35-38, 52-63`. Смерть между `repo.create` и `queue.enqueue` оставляет строку `queued` навсегда (поллера по `queued` нет), а ретрай с тем же dedupeKey возвращает `{deduped: true}` на осиротевшую строку — задача невоскресима. Фикс: boot-time reconciliation `queued`-строк без живого job'а или enqueue-first с идемпотентным jobId.
- **P1-2. Задачи, создаваемые в обход intake-чокпойнта, плодят orphan `queued`-строки, блокирующие allTerminal навсегда** — `backtest-support.ts:138-158`, `backtest-completed.handler.ts:53-72`, `research-run-cycle.handler.ts:433-445`. `researchTasks.create` безусловный (dedupeKey в строку не пишется — NULL, индекс не работает), дедуп только на BullMQ jobId, который молча игнорирует дубликат `Queue.add`. Повторное исполнение enqueue-пути = вторая строка, застрявшая в `queued` → в связке с P0-1 триггер ревизии по этой корреляции не сработает никогда. Фикс: провести все три пути через `createAndEnqueueTask` с dedupeKey на строке.
- **P1-3. Воркер без терминального guard'а: stalled-redelivery повторно гоняет LLM-циклы** — `src/worker/worker.ts:15-23`. Задача сразу флипается в `running` без проверки, что она уже `completed`; redelivery после краша между dispatch и ack повторяет `research.run_cycle` — свежие LLM-вызовы, новые фингерпринты, вторая пачка гипотез в той же корреляции. Фикс: idempotency fence (`if terminal return`) + условный `queued→running`.
- **P1-4. Ретраи без классификации ошибок: детерминированные отказы гоняются 3× по полной LLM-цене; poison-задачи невидимы** — `src/adapters/queue/bullmq-queue.adapter.ts:52-62`. Валидационные/not-found ошибки должны кидать `UnrecoverableError`; failed-джобы никем не мониторятся. 
- **P1-5. `pending`-ран без callback-URL не резюмируется автоматически, и гипотеза молча выпадает из ревизии** — `run-platform-backtest.ts:84-87`, `resume-platform-backtest.ts:186-190`. `hypothesis.build` завершается `completed`, allTerminal проходит без результата этой гипотезы — `revision.build` собирается без неё. Фикс: scheduler-tick `resumePendingPlatformRuns` или delayed-задача `backtest.resume` на выходе `pending`.
- **P1-6. `paper.start`: транзиентный сбой evidence-провайдера жжёт dedupeKey и перманентно теряет чемпиона** — `paper-start.handler.ts:216-239` + `strategy-wfo.handler.ts:50-61`. `provider_unavailable` → тихий `return` (task `completed`), повторный enqueue дедупится навсегда. Fail-closed решение (079 I1) верно, неретраебельность — нет. Фикс: throw на транзиентной недоступности (ретрай воркера), тихий return — только на настоящий verification reject; либо писать `paper_submission` со статусом `failed` для sweep'а.

### Revision-lane / консолидация

- **P1-7. Гонка на выделении версии — второй механизм, заставляющий concurrency=1** — `revision-build.handler.ts:160, 232, 263`, `revision-consolidate.handler.ts:56`. `findLatestAccepted → create(version+1)` без локов; проигравший теряет весь цикл с единственным событием `revision.skipped`, его `proxy_passed`-гипотезы никогда не подметаются. Фикс: per-profile сериализация (`pg_advisory_xact_lock(hashtext(profileId))` или BullMQ group), либо re-enqueue проигравшего с backoff.
- **P1-8. Краш между create консолидированной ревизии и enqueue `strategy.baseline` — re-baseline не случится никогда** — `revision-consolidate.handler.ts:56→66`, short-circuit `:90-93`. Ретрай упирается в `already_consolidated` и выходит без enqueue; consolidated-голова остаётся с `baselineValidationStatus: 'pending'` навсегда. Фикс: в ветке `already_consolidated` идемпотентно до-enqueue'ивать `strategy.baseline`, пока статус `pending` (dedupeKey уже делает это безопасным).
- **P1-9. Проваленный re-baseline не демотирует consolidated-голову; `strategy.wfo` enqueue'ится безусловно** — `strategy-baseline.handler.ts:67-91`, `revision-consolidate.handler.ts:50`. FAIL/MODIFY пишет только `baselineValidationStatus: 'failed'`, но строка остаётся `accepted` версии R+1 и навсегда затмевает R в `findLatestAccepted` — все будущие циклы стекуются на LLM-переписанном бандле, проваливашем holdout. Инвариант «fail-safe: R остаётся source of truth» нарушен. Фикс: на `failed` → `status: 'rejected'` (откат головы к R); WFO — только по положительному вердикту.
- **P1-10. Preservation-гейт: try шире, чем надо — баг логики гейта тихо снимает veto под ложным `fetch_failed`; gateOn выключается без следа** — `revision-build.handler.ts:323, 339-353` (то же в proxy-lane `backtest-support.ts`). try оборачивает не только два фетча трейдов, но и `applyRevisionPreservationGate`: исключение в `evaluateTradePreservation` = систематически потерянное veto. Отдельно: `gateOn=false` при null `baselinePlatformRunId` не эмитит вообще никакого события. Фикс: сузить try до фетчей (ошибка гейта — fail-closed), эмитить `preservation_skipped: no_baseline_run_id`.
- **P1-11. `parseTrade` коэрсит мусор с провода в правдоподобные трейды — вход preservation-veto фиктивен при schema drift** — `http-backtester.adapter.ts:440-442`. `side: r.side === 'short' ? 'short' : 'long'`, `realizedPnl: number ? : 0` — побитый артефакт превращается в `long/0`-трейды, гейт сравнивает фикцию (возможен и ложный veto, и ложный pass). Фикс: нераспознанный `side`/нечисловой `realizedPnl` → существующий `preservation_skipped`-путь, симметрично со строгими `entryTs/exitTs`.
- **P1-12. Parity-проверка консолидации вакуумна при отсутствии метрик** — `src/validation/consolidation-evaluator.ts:27`. `typeof !== 'number' → continue`: если метрики деградировали, все 8 PARITY_FIELDS скипаются и ACCEPT достигается по одному trade-count. Фикс: асимметрия «number vs missing» = REJECT (`metric_missing:<field>`); скип — только когда поля нет с обеих сторон.
- **P1-13. Нет потолка на попытки консолидации: depth и стек source растут бесконечно, каждая попытка = LLM + полный бэктест** — все 11 reject-путей `revision-consolidate.handler.ts` + `revision-build.handler.ts:413-425`. Систематический парити-фейл (LLM не может воспроизвести `totalTrades` EXACT) = линейный рост навсегда; при default-пороге 2 даже успешная консолидация даёт steady-state «лишний LLM+бэктест+re-baseline+WFO на каждую accepted-ревизию». Фикс: счётчик попыток на lineage + hard ceiling на `compositionDepth`.
- **P1-14. `mergedRuleSet.theses` — позиционный массив, а консолидатору он скармливается как `Record<hypothesisId, thesis>`** — `revision-consolidate.handler.ts:114` vs `compose-revision-bundle.ts:265-276`. LLM получает массив с null-дырами вместо связки rule↔thesis; v1-bootstrap (`order: []`) маскирует баг в тестах. Фикс: зипануть `order` с массивом в настоящий record на границе хэндлера.
- **P1-15. Greedy-degradation: ранние break'и оставляют строку ревизии лгущей о своём составе** — `revision-build.handler.ts:370-395, 428-431`. `dropped_combo_fail`-статусы и события пишутся, но `hypothesisIds/dropped/bundle`-указатели строки обновляются только на пути через recompose; финальный reject-patch их не включает — rejected-строка перечисляет дропнутую гипотезу и указывает на бандл прошлой попытки. Фикс: включить `hypothesisIds: currentIds, dropped` в финальный `updateStatus`.

### Конфигурация / развёртывание

- **P1-16. Docker: явный env-allowlist молча роняет десятки задокументированных переменных; `BACKTESTER_API_URL/TOKEN` не пробрасываются вовсе** — `docker-compose.yml:162-237`. VPS-деплой с `TRADING_PLATFORM_INTEGRATION=backtester` тихо шлёт сабмиты в `http://127.0.0.1:8080` *внутри контейнера* (`select-research-platform.ts:10` дефолтит). Также непробрасываемы: `CONSOLIDATOR_*`, `LAB_CONSOLIDATION_*`, `EVAL_*`, `LAB_TRADE_PRESERVATION_*` (весь гейт R2!), `WFO_*`, `PLATFORM_RUN_MAX_POLLS/POLL_DELAY_MS`, `MAX_HYPOTHESES_PER_CYCLE`, `ARTIFACT_DIR` и др. Фикс: `env_file:`/pass-through для всего, что читает `loadEnv`; boot-лог эффективной матрицы адаптеров.
- **P1-17. Fail-open парсинг адаптеров: опечатка = Fake/mock в проде** — `src/config/env.ts:210-212, 227-228`, `src/composition.ts:122-184`. `LAB_AGENTS_ADAPTER=Mastra` (опечатка в регистре) → `FakeStrategyAnalyst` со стабовым выхлопом против реальных бюджетов; `TRADING_PLATFORM_INTEGRATION` c опечаткой → mock. Плюс: `STRATEGY_CRITIC_ADAPTER=mastra` при неподнятых агентах тоже тихо падает в Fake (composition.ts:148-156). Контраст с fail-closed `parseBotResultsIntegration`/`parseSignedEvidenceSource`, которые бросают. Boot-guard «fixture в prod» существует только для signed-evidence. Фикс: throw на нераспознанных значениях; production-guard для остальных fixture/fake-адаптеров.
- **P1-18. Ingress healthcheck пробит на опциональный listener: без `TRADING_LAB_READ_TOKEN` контейнер вечно `unhealthy` и office не стартует** — `docker-compose.yml:143-148` vs `src/ingress/server.ts:45-47, 103`. Фикс: healthcheck на всегда-живой эндпоинт `:3000`.
- **P1-19. Read-api auth: пустой токен = обход** — `src/read-api/auth.ts:7-15` + `src/composition.ts:524` (`token: env.TRADING_LAB_READ_TOKEN ?? ''`). Подтверждено: 503-ветки на пустой токен нет (в отличие от `bearerAuth`, `src/auth/bearer-auth.ts:32-38`), `Authorization: Bearer ` даёт `safeEqual('','') === true`. Сегодня спасает только то, что listener не стартует без токена — одноуровневая защита в другом файле; любой будущий маунт `createReadApp` открывает весь read-surface. Фикс: общий `bearerAuth` + запрет пустого токена.

### CAS / артефакты

- **P1-20. `LocalFileArtifactStore.get()` читает произвольный `file://` URI из БД: нет containment в baseDir, нет сверки content-hash** — `local-file-artifact-store.adapter.ts:38-40` (подтверждено). Подставной ref читает любой файл ФС; даже честный ref не защищён от подмены блоба после записи (TOCTOU): `reconstructStrategyBundle` сверяет `bundleHash` *изнутри самого артефакта* — самосогласованная проверка. Фикс: resolved-путь обязан лежать под `baseDir`; пересчитывать sha256 против `ref.content_hash` при чтении.
- **P1-21. Неатомарная запись в shared CAS** — `local-file-artifact-store.adapter.ts:23-24`. Конкурентный читатель (бэктестер через shared `.artifacts`, транспорт 066) может увидеть полузаписанный файл под именем, «утверждающим» его хеш. Фикс: temp-файл + `rename()`, skip-if-exists.

### Чат / operator

- **P1-22. Чат-LLM-вызовы целиком вне token-kill-switch, rate limiting отсутствует** — `mastra-turn-interpreter.ts:27-33`, `chat-handler.ts:207`, `chat-app.ts:26-48`. Интерпретатор не читает `usage` вовсе; пре-флайт критик вызывается без `onUsage` (а two_stage — это 2 вызова); на `POST /chat/messages` нет ни лимитера, ни per-session конкуренции. Утёкший чат-токен/зацикленный клиент = неограниченный расход, невидимый бюджет-гейту (каждый turn — свежий chatRequestId). Фикс: учитывать usage на чат-границе + простой лимитер.
- **P1-23. Confirmation-flow: залипшая сессия и ложное «Отменил»** — `chat-handler.ts:75-80, 98-105`. Ветка `already_confirmed` не чистит `pendingInteraction`: после краша между `confirmPending` и созданием задачи сессия навсегда в цикле «Не понял ответ» (интерпретатор не вызывается). Ветка `cancel` игнорирует boolean от `cancelPending`: отмена уже подтверждённой заявки отвечает «Отменил», а задача продолжает исполняться. Фикс: чистить pending; честный ответ при `cancelPending() === false`.
- **P1-24. SSE `/v1/stream`: не-await'нутые записи → unhandled rejection; replay без abort-check** — `src/read-api/routes/stream.ts:67, 73-79, 85`. Reject записи в закрытый сокет уходит мимо try/finally (в связке с P0-7 — потенциально фатально); отвалившийся клиент с древним `?cursor=` заставляет пролистать весь `agent_event`. Фикс: catch вокруг pump/heartbeat, проверка `signal.aborted` в replay-цикле.

### БД-слой

- **P1-25. Unique-индексы-«backstop'ы» нигде не ловятся: гонка = сырой 23505-краш** — repo-wide подтверждено (ноль обработки 23505, ноль `.transaction(`). Два конкурентных сабмита с одним dedupeKey: проигравший получает HTTP 500 вместо `{deduped: true}`; то же для fingerprint-backstop'а гипотез. Фикс: catch 23505 → re-read → вернуть победителя.
- **P1-26. `metricsFromRow`: единственный null-сентинел `netPnlUsd` + 8 non-null assertions** — `drizzle-backtest-run.repository.ts:11-18` (дублировано в `drizzle-backtest-read.adapter.ts`). Частичная строка → `null as number` → NaN в эвалюаторе/гейте вместо громкого отказа — тот самый toDomain-класс багов, уже кусавший проект. Фикс: валидировать все девять полей.
- **P1-27. Lost update между `upsertByExperimentId` и `updateMonitorState`** — `drizzle-paper-submission.repository.ts:35-96`. `onConflictDoUpdate` перезаписывает monitor-поля снапшотом вызывающего: ретрай `paper.start` наперегонки с tick'ом `paper.monitor` тихо откатывает прогресс наблюдения. Фикс: upsert не трогает monitor-owned колонки (или version-колонка).
- **P1-28. Статусные переходы — безусловные UPDATE без state-machine guard'а** — `drizzle-research-task.repository.ts:51-58` (та же картина в hypothesis/revision-репо). Протухший ретрай может флипнуть `completed` обратно в `running` — hazard, о котором `chain-runner.ts:28` предупреждает словами, но не кодом. Фикс: `WHERE status IN (<законные предшественники>)`, 0 rows = сигнал no-op.

### Известная недоработка с blast-radius

- **P1-29. HTTP-провайдер signed-evidence: `available = true`, но всегда `null`** — `select-signed-evidence.ts:46-52` (известный TODO 079-followup, ждёт Deliverable A бэктестера). Blast radius: при `LAB_PAPER_EVIDENCE_REQUIRED=false` конфигурация `source=http` **молча** шлёт paper-кандидатов без evidence; при `required=true` каждый `paper.start` детерминированно падает `provider_returned_null` (и по P1-6 — с потерей чемпиона). Фикс до поставки: `available=false` либо `not_implemented`-throw на boot'е.

---

## P2 — Гигиена: удаления, дрейф, орфаны

- **Orphan CAS-блобы**: каждый parity-reject консолидации оставляет completed clean-run и запушенный на платформу бандл без ссылок; `cleanRef` кладётся в CAS **до** `revisions.create` — на race-skip блоб орфанится, и из-за недетерминизма LLM никогда не переиспользуется (`revision-consolidate.handler.ts:39, 121-128`). Известный follow-up; нужен GC-sweep или перенос put после create.
- **`.env.example` ↔ `loadEnv` дрейф в обе стороны**: не задокументированы `BACKTESTER_*`, `CONSOLIDATOR_*`, `LAB_CONSOLIDATION_*`, `EVAL_*` (6), `LAB_TRADE_PRESERVATION_*` (7), `WFO_*` (6), `PLATFORM_RUN_*`, `LAB_OPS_READ_*` и др.; обратно — `TRADE_CONTEXT_WARMUP_MIN/TAIL_MIN`, `MARKET_HISTORY_LOOKBACK_DAYS`, `RESEARCHER_MAX_PER_PASS` читаются сырым `process.env` в рантайме хэндлера мимо `Env`-интерфейса (`research-run-cycle.handler.ts:225-341`); `OPERATOR_EMBEDDING_PROVIDER` — мёртвая ручка (захардкожен `'openrouter'`, `env.ts:350`).
- **Числовые парсеры молча глотают мусор** — `env.ts:158-180`: `LAB_QUEUE_CONCURRENCY=two` → 1 без лога; `parsePort` принимает отрицательные/дробные; доли (preservation shares, `TURN_INTERPRETER_MIN_CONFIDENCE`) без range-check [0,1].
- **Dockerfile**: `--frozen-lockfile || --no-frozen-lockfile` маскирует lockfile-дрейф (у проекта уже есть stale-node_modules gotcha); root-user; `NODE_ENV` не задан (а `select-signed-evidence` ветвится по `NODE_ENV==='test'`); dev-deps в образе.
- **`ARTIFACT_DIR` без volume**: `.artifacts` пишется в эфемерную ФС контейнера — shared-CAS транспорт (066) в Docker-деплое не работает между worker/ingress/backtester, артефакты теряются при recreate.
- **Механический скан**: dead code — 1 символ (`_CanonReason`, underscore-префикс, намеренный); dead-клонов нет; серьёзных циклов нет; contracts (`action=check`) — без orphan'ов; TODO — 6, единственный load-bearing = P1-29. *Caveat: SAST-скан gortex споткнулся о стейл-пути старого расположения репо (`~/projects/trading-lab`) — стоит переиндексировать; coverage-данные в граф не загружены (нет lcov), coverage-анализаторы пусты.*

---

## P3 — Узкие места и рефактор-цели

### Что именно держит конвейер на concurrency=1 (и как разблокировать)

Три конкретных механизма (все подтверждены по коду):
1. **Zero-fire триггер закрытия цикла** (P0-1) — неатомарный `allTerminal`.
2. **Выделение версии ревизии** (P1-7) — `findLatestAccepted → create(version+1)` без per-profile лока; сюда же P0-3 (ложный `concurrent_revision` на ретраях).
3. **Идемпотентность ран-экзекьютора** (P0-4) — check-then-insert по `strategy_backtest_run_idem_uq` без обработки конфликта; identity базлайна разделяется всеми ревизиями профиля.

Порядок работ: сначала P0-1/P0-3/P0-4 + P1-2 (все enqueue через intake) + P1-3 (idempotency fence воркера), затем per-profile сериализация revision-lane (advisory lock / BullMQ groups) — после этого `LAB_QUEUE_CONCURRENCY` можно поднимать; revision-lane остаётся сериализованной *по профилю*, не глобально.

### Head-of-line blocking и латентность

- Синхронные поллы до 60 c (`pollOverlayRun`) и многоминутные LLM-вызовы живут внутри хэндлеров на однопоточной lane: любая задача (chat-задачи, tick'и монитора, webhook-resume) ждёт хвост текущей (`run-platform-backtest.ts:80-82`, `env.ts:236-237`).
- Бюджет полла vs реальность: `30 × 2000ms = 60s` на research-ран — месячный 1-min слайс живёт дольше → лишний цикл `pending→resume`; фиксированный интервал 1-2 s без backoff долбит сервис (`http-backtester.adapter.ts:188-189`).
- `research.run_cycle`: до 5+10 окон market-history фетчатся последовательными await'ами, critic-ревью серийные — `Promise.all`/ограниченный параллелизм срезали бы wall-clock самого тяжёлого хэндлера (`research-run-cycle.handler.ts:232-271, 446-467`).
- Bare `fetch` без таймаута в `ops-read-client.ts:259` (+ `:43`) — повисший сокет платформы вешает lane бесконечно (job не фейлится, lock продлевается). `AbortSignal.timeout` + 1 ретрай на GET.
- Циклы пагинации без потолка и с неограниченной буферизацией: `http-trade-evidence.adapter.ts:100-106`, `http-backtester.adapter.ts:462-468` (бесконечный цикл + OOM на зацикленном курсоре); `http-market-history.adapter.ts:284-290` буферит всё окно в Map.
- Чат-turn строго последовательный: interpreter → retrieval → critic + 5-8 await'нутых INSERT'ов событий на turn (`chat-handler.ts:140-254`).

### БД: индексы и запросы

- Нет индекса на `platform_run_id` в обеих run-таблицах — ingress completion path и `backtest-resume` делают seq scan по таблицам с тяжёлыми jsonb (`drizzle-backtest-run.repository.ts:70`, `drizzle-strategy-backtest-run.repository.ts:53`); должен быть `uniqueIndex` (заодно кодифицирует 1:1-инвариант).
- Поллеры без индексов: `listWatching` (`monitor_status`), `findConsolidatedOf` (`consolidated_from_revision_id`), `listByType` (`experiment_type`), `listResumablePlatformRuns` (SELECT * всех jsonb, без LIMIT). Дешёвые partial-индексы (`WHERE monitor_status='watching'`, `WHERE status='submitted'`).
- Горячейший read-path — catch-up pg-notify стрима — на каждой странице LEFT JOIN'ит `research_task` даже без correlationId-фильтра (`drizzle-agent-event-read.adapter.ts:29-35`); бросивший подписчик абортит страницу и дублирует доставку всем (`pg-notify-agent-event-stream.ts:79-83`).

### Ресурсы и lifecycle

- Мультипликация коннектов: каждый `BullMqQueueAdapter` — своя ioredis-пара; worker = 4 Redis-коннекта, ingress = 2; ingress строит **весь** worker-граф (все Mastra-агенты, экзекьюторы), хотя только enqueue'ит; 2 × `LAB_PG_POOL_MAX=10` = 20 pg-коннектов на фактически 1 конкурентный job (`composition.ts:319-537`).
- Shutdown частичный и небезлимитный: HTTP-серверы не закрываются (`serve()` не сохраняется), `queue.close()` без дедлайна при дефолтных 10 s Docker-grace (минутный research-job получает SIGKILL → строка `running` без реконсиляции), `AggregateError` из `RoutingQueueAdapter.close()` не даёт дойти до `pool.end()` (`ingress/server.ts:49-54`, `worker/worker.ts:52-59`).

### Рефактор-цели (по health_score: 202 F-символа из 2442)

| Символ | Метрика | Замечание |
|---|---|---|
| `researchRunCycleHandler` (`research-run-cycle.handler.ts:144`) | fan-out **141**, 17 community-crossings | Худший символ репо; декомпозиция по фазам (context → researcher → critic → dispatch) назрела |
| `revisionBuildHandler` (`revision-build.handler.ts:152`) | fan-out 87 | Шаги 1-5 в одном теле; P1-15 — прямое следствие |
| `loadEnv` (`env.ts:209`) | fan-in 86 / fan-out 51 | + P2-парсеры; разбить на модульные секции |
| `handleChatMessage` (`chat-handler.ts:122`) | fan-out 43 | + последовательный turn |
| `composeRuntime` (`composition.ts:319`) | 19 community-crossings | Разделить worker/ingress composition (см. ресурсы выше) |

---

## P4 — Бэклог / мелочь

- Vendored canonicalizer «byte-identical to backtester» держится на комментарии — нет pin-теста/фикстуры «подписано бэктестером v1 → верифицируется» (`evidence-canonical.ts:64-66`); дрейф fail-closed'ится, но диагностируется как загадочный `evidence_signature_invalid`.
- `select-research-platform.ts:9-12` / `select-run-trades.ts:28-31` читают `process.env` напрямую и дефолтят токен в `''` — против собственной boot-safe конвенции репо.
- Сырое сообщение ошибки LLM-провайдера персистится в `agent_event` и отдаётся офису через `/v1/agent-events` (`chat-handler.ts:149, 217`) — маппить в коды ошибок.
- `onUsage` не вызывается, если `agent.generate` бросил после фактического потребления — бюджет-гейт недосчитывает (`mastra-researcher.ts:182-192` и родственные).
- `hypothesis_build`-строки виснут в `generating` при throw после `createGenerating` — каждая retry-попытка создаёт новый buildId, старые лгут в ledger (`hypothesis-build.handler.ts:277-327`); нужен `markBuildFailed` в catch.
- `/v1/agents/:agentId/traces`: prototype-lookup по невалидированному параметру — `GET /v1/agents/constructor/traces` = 500 (`agent-traces.ts:9-11`); `Object.hasOwn` или 404 по таксономии.
- PhoenixTraceReader тянет `/spans?limit=200` всего проекта без фильтра/пагинации — активный проект вытесняет трейсы агента → стабильный `no-traces` (`phoenix-trace-reader.ts:56-68`).
- `getRunStatus` в catch-ветке конфликта не обёрнут в `toGatewayError` — ломается таксономия ошибок (`http-backtester.adapter.ts:354`).
- `submitStrategyRun` catch-all превращает всё в неразличимый `{status:'unavailable'}` без лога; на deadline не зовётся `cancelRun` — ран продолжает крутиться на сервере (`http-backtester.adapter.ts:421-423`).
- Репо-обновления, тихо no-op'ающиеся на отсутствующей строке (`drizzle-research-experiment.repository.ts:80-112`, `drizzle-chat-plan.repository.ts:50-56`); `updateMember({})` бросает «No values to set».
- Все статус-колонки — plain text c `as`-кастами без CHECK/pgEnum (задокументированный trust boundary; P1-26 показывает, где эта же доверчивость уже режет).

---

## Что проверено и чисто (позитив)

- Evidence-цепочка 079: лестница verify (signature→verdict→hash-pin→scope) без обходов, `Object.hasOwn` против prototype pollution, merge trustedSigners env-последним, fixture-провайдер fail-closed вне test.
- Атомарный confirm заявок (условный UPDATE + `gt(expiresAt)` в `drizzle-action-proposal.repository.ts:65-77`) — double-confirm закрыт.
- `bearerAuth` fail-closed 503 на неконфигурированном токене; auth-middleware раньше хэндлеров на всех трёх границах; `safeEqual` constant-time.
- `resumeToken` делает replay сабмита идемпотентным; preservation-фетч идёт по `platformRunId` (пост-фикс PR#150 на месте).
- `parseTrustedSigners` и RAG-конфиг бросают на мусоре (образец для P1-17/P2-парсеров); paper-window policy кросс-валидируется на boot'е.

## Рекомендованный порядок работ

1. **Стабилизация петли (P0)**: атомарный cycle-closure триггер + терминальные выходы hypothesis.build (P0-1/2), идемпотентность revision.build + sweep протухших candidate (P0-3), resume-or-adopt в run-executor (P0-4), retry-able paper.monitor + рабочий revival (P0-5), фикс pg-notify стрима и `pool.on('error')`+global handlers (P0-6/7). Это одновременно и prerequisite для подъёма `LAB_QUEUE_CONCURRENCY`.
2. **Fail-closed конфигурация (P1-16/17/18/19)**: docker env-пробросы, throw на опечатках адаптеров, healthcheck, read-auth — дёшево, а закрывает целый класс «тихо не то запустили».
3. **Целостность данных (P1-20/21, P1-25/26/27/28)**: CAS containment+hash-verify+атомарная запись; 23505-обработка; state-machine guard'ы.
4. **Consolidation-контур (P1-8/9/12/13/14)** — до включения `CONSOLIDATOR_ADAPTER=mastra` в live.
5. **Пропускная способность (P3)**: per-profile сериализация → подъём concurrency; таймауты на все внешние fetch'и; индексы; параллелизация run_cycle.
