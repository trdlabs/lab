# ENV — trading-lab

<!-- GENERATED FILE — не редактировать руками. Источник: src/config/env-schema.ts. -->
<!-- Перегенерация: `pnpm env:docs`. Машинный экспорт: `pnpm env:schema`. -->

Схема соответствует контракту `env-schema.1`
(control-center, `docs/architecture/contracts/env-schema.md`).
Значения секретов здесь не появляются никогда — только имя и форма;
живые значения — в `.env.vps` на хостах и SOPS/age-контуре.

Переменных: 121. Точка чтения — `src/config/env.ts` (loadEnv) и явно перечисленные consumers.

| Имя | Тип | Обяз. | Default | Secret | Flag | Описание |
| --- | --- | --- | --- | --- | --- | --- |
| `AGENT_ACTIVITY_REBUILD_WINDOW_HOURS` | int | — | `24` | — | — | Окно перестроения ленты агентной активности, часов |
| `AGENT_ACTIVITY_TRACE_LIMIT` | int | — | `50` | — | — | Максимум трейсов в ленте агентной активности |
| `AGENT_EVENT_STREAM_HEARTBEAT_MS` | duration_ms | — | `15000` | — | — | Heartbeat SSE-потока агентных событий, мс |
| `AGENT_EVENT_STREAM_SAFETY_TICK_MS` | duration_ms | — | `5000` | — | — | Safety-tick SSE-потока агентных событий, мс |
| `ANTHROPIC_API_KEY` | string | — | — | да | — | API-ключ Anthropic (LLM-провайдер anthropic) |
| `ARTIFACT_DIR` | string | — | `.artifacts` | — | — | Каталог артефактов исследований (бандлы, отчёты) |
| `BACKTESTER_API_TOKEN` | string | — | — | да | — | Bearer-токен API бэктестера |
| `BACKTESTER_API_URL` | url | — | — | — | — | Базовый URL API бэктестера; селекторы run-trades/research-platform подставляют http://127.0.0.1:8080 при отсутствии |
| `BUILDER_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер builder: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `BUILDER_MODEL` | string | — | `anthropic/claude-sonnet-4-6` | — | — | Модель builder-агента |
| `CHAT_MAX_MESSAGE_CHARS` | int | — | `4000` | — | — | Максимальная длина chat-сообщения, символов |
| `CHAT_RATE_MAX_TURNS` | int | — | `30` | — | — | Rate-limit: максимум chat-ходов на окно на инстанс (0 = выключен) |
| `CHAT_RATE_WINDOW_MS` | duration_ms | — | `60000` | — | — | Rate-limit: окно подсчёта chat-ходов, мс |
| `CONSOLIDATOR_ADAPTER` | enum(off, fake, mastra) | — | `off` | — | — | LLM-консолидация (G3b); OFF если не включена явно — НЕ наследует LAB_AGENTS_ADAPTER |
| `CONSOLIDATOR_MODEL` | string | — | `openrouter/anthropic/claude-opus-4-8` | — | — | Модель consolidator-агента (CONSOLIDATOR_ADAPTER=mastra) |
| `CRITIC_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер critic: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `CRITIC_MODEL` | string | — | `anthropic/claude-sonnet-4-6` | — | — | Модель critic-агента |
| `DATABASE_URL` | url | — | — | да | — | PostgreSQL connection string (несёт креды — secret); без неё персистентные адаптеры не собираются |
| `ENABLE_CRITIC_AGENT` | bool | — | `false` | — | — | Включает critic-агента в research-цикле |
| `EVAL_FRAGILITY_TOP_TRADE_PCT` | float | — | `50` | — | — | Порог оценщика: доля топ-сделки (fragility), % |
| `EVAL_MAX_DRAWDOWN_TOLERANCE_PCT` | float | — | `2` | — | — | Порог оценщика: допуск по просадке, % |
| `EVAL_MIN_PNL_DELTA_USD` | float | — | `0` | — | — | Порог оценщика: минимальная дельта PnL, USD |
| `EVAL_MIN_PROFIT_FACTOR` | float | — | `1.5` | — | — | Порог оценщика: минимальный profit factor |
| `EVAL_MIN_TRADES` | int | — | `20` | — | — | Порог оценщика: минимум сделок |
| `EVAL_STRONG_PNL_DELTA_USD` | float | — | `100` | — | — | Порог оценщика: сильная дельта PnL, USD |
| `INGRESS_PORT` | int | — | `3000` | — | — | Порт HTTP ingress-сервера |
| `LAB_AGENTS_ADAPTER` | enum(fake, mastra) | — | `fake` | — | — | Общий дефолт всех агентных адаптеров (fake/mastra); частные *_ADAPTER переопределяют (fail-closed) |
| `LAB_ALLOW_FIXTURE_EVIDENCE` | bool | — | `false` | — | — | Явное разрешение fixture-evidence вне NODE_ENV=test (self-signed, никогда для прод-гейтов) |
| `LAB_BOT_RESULTS_INTEGRATION` | enum(mock, fixture, http) | — | `mock` | — | — | Ось чтения bot-results/trade-evidence (отдельная от TRADING_PLATFORM_INTEGRATION; fail-closed) |
| `LAB_BREAK_BATTERY_MODE` | enum(off, log) | — | `off` | — | off/log → off | Флаг E4b-паттерна: режим раскатки break_battery@1 (R11). off — батарея не запускается; log — запускается, персистит и логирует, вердикты не меняет. Состояние enforce намеренно отклоняется резолвером до пиновки порогов владельцем (research-validation-hardening item 7) |
| `LAB_CONSOLIDATION_DEPTH_THRESHOLD` | int | — | `2` | — | — | Порог глубины вложенности, запускающий revision.consolidate; 0 = kill-switch |
| `LAB_CONSOLIDATION_TOL_ABS` | float | — | `0.01` | — | — | Абсолютный допуск parity-гейта консолидации |
| `LAB_CONSOLIDATION_TOL_REL` | float | — | `0.001` | — | — | Относительный допуск parity-гейта консолидации |
| `LAB_MARKET_HISTORY_URL` | url | — | — | — | — | URL market-history-поверхности; при отсутствии — LAB_OPS_READ_URL, затем http://mock-platform:8839 |
| `LAB_OPS_READ_FIXTURE_DIR` | string | — | — | — | — | Каталог фикстур для fixture-режима bot-results/trade-evidence; дефолт — встроенный каталог фикстур |
| `LAB_OPS_READ_TOKEN` | string | — | — | да | — | Bearer-токен ops-read-поверхности |
| `LAB_OPS_READ_URL` | url | — | — | — | — | Базовый URL ops-read-поверхности (bot-results/trade-evidence/market-history); фолбэк http://127.0.0.1:8839 в селекторах |
| `LAB_PAPER_EVIDENCE_REQUIRED` | bool | — | `false` | — | — | Fail-closed гейт: при true boot отказывает без не-none источника signed-evidence |
| `LAB_PAPER_INTAKE_TOKEN` | string | — | — | да | — | Bearer-токен paper-intake платформы |
| `LAB_PAPER_INTAKE_URL` | url | — | — | — | — | URL paper-intake платформы; не задана — интейк выключен (submit возвращает ошибку вызывателю) |
| `LAB_PG_POOL_MAX` | int | — | `10` | — | — | Максимальный размер пула PostgreSQL-соединений |
| `LAB_QUEUE_CONCURRENCY` | int | — | `1` | — | — | Конкурентность BullMQ-воркера research-задач |
| `LAB_REVISION_QUEUE_CONCURRENCY` | int | — | `1` | — | — | Конкурентность очереди revision-оценок |
| `LAB_SIGNED_EVIDENCE_SOURCE` | enum(none, fixture, http) | — | `none` | — | — | Источник подписанной backtest-evidence; fixture вне NODE_ENV=test требует LAB_ALLOW_FIXTURE_EVIDENCE=true (fail-closed) |
| `LAB_TRADE_PRESERVATION_ABSTENTION_SHARE` | float | — | `0.7` | — | — | Trade-preservation: допустимая доля воздержаний |
| `LAB_TRADE_PRESERVATION_EOD_SHARE` | float | — | `0.5` | — | — | Trade-preservation: допустимая доля EOD-закрытий |
| `LAB_TRADE_PRESERVATION_GATE` | enum(on, off) | — | `on` | — | — | Kill-switch trade-preservation-гейта; выключается только явным off |
| `LAB_TRADE_PRESERVATION_MATCH_TOLERANCE_MS` | float | — | `0` | — | — | Trade-preservation: допуск сопоставления сделок, мс |
| `LAB_TRADE_PRESERVATION_MAX_TRADE_DROP_PCT` | float | — | `20` | — | — | Trade-preservation: максимум потери сделок, % |
| `LAB_TRADE_PRESERVATION_MIN_WINNER_SAMPLE` | float | — | `3` | — | — | Trade-preservation: минимальная выборка выигрышных сделок |
| `LAB_TRADE_PRESERVATION_WINNER_RETENTION` | float | — | `0.9` | — | — | Trade-preservation: доля сохранённых выигрышных сделок |
| `LAB_TRUSTED_SIGNERS_JSON` | string | — | — | — | — | JSON-карта keyId -> SPKI PEM для верификации подписанной backtest-evidence; пусто = {}; невалидный JSON валит старт (fail-fast) |
| `LAB_U6_IMAGE` | string | — | — | — | — | Деплой-переменная compose (юнит U6, F5a): digest-pinned образ lab (ghcr.io/trdlabs/lab@sha256:<64 hex>); обязательная интерполяция в docker-compose.vps.yml, кодом не читается |
| `MARKET_HISTORY_LOOKBACK_DAYS` | int | — | `7` | — | — | Lookback market-history для research-цикла, дней (прямое чтение в research-run-cycle.handler) |
| `MAX_HYPOTHESES_PER_CYCLE` | int | — | `5` | — | — | Максимум гипотез на research-цикл |
| `MODEL_PROVIDER` | enum(anthropic, openai, openrouter) | — | `anthropic` | — | — | LLM-провайдер по умолчанию (неизвестное значение тихо откатывается к anthropic) |
| `NODE_ENV` | string | — | — | — | — | Стандартная нода-переменная; в lab читается только guard'ом fixture-evidence (=== test) |
| `OPENAI_API_KEY` | string | — | — | да | — | API-ключ OpenAI (LLM-провайдер openai) |
| `OPENROUTER_API_KEY` | string | — | — | да | — | API-ключ OpenRouter (LLM-провайдер openrouter, embeddings) |
| `OPERATOR_EMBEDDING_DIMENSIONS` | int | — | `1024` | — | — | Размерность эмбеддингов; поддержана только 1024 — любое другое значение валит старт (fail-fast) |
| `OPERATOR_EMBEDDING_MODEL` | string | — | `baai/bge-m3` | — | — | Slug embedding-модели operator-retrieval |
| `OPERATOR_RAG_ENABLED` | bool | — | `false` | — | — | Включает operator-RAG-retrieval |
| `OPERATOR_RERANKER` | enum(mastra, none) | — | `none` | — | — | Reranker-бэкенд: mastra (LLM) или none (порядок RRF) |
| `OPERATOR_RERANK_LIMIT` | int | — | `5` | — | — | Максимум кандидатов из reranker |
| `OPERATOR_RERANK_MIN_CANDIDATES` | int | — | `10` | — | — | Минимум кандидатов для объёмного reranking |
| `OPERATOR_RERANK_RRF_MARGIN` | float | — | `0.002` | — | — | RRF-порог неоднозначности: зазор топ-2 <= порога включает reranking |
| `OPERATOR_RERANK_TIMEOUT_MS` | duration_ms | — | `1500` | — | — | Максимум ожидания reranker до отката к RRF, мс |
| `OPERATOR_RETRIEVAL_FUSED_LIMIT` | int | — | `20` | — | — | Максимум кандидатов после fusion/re-rank |
| `OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS` | duration_ms | — | `10000` | — | — | Жёсткий таймаут retrieval; обязан быть >= мягкого (fail-fast) |
| `OPERATOR_RETRIEVAL_INDEX_VERSION` | int | — | `1` | — | — | Версия схемы retrieval-индекса |
| `OPERATOR_RETRIEVAL_LEXICAL_LIMIT` | int | — | `50` | — | — | Максимум кандидатов лексической (BM25) стадии |
| `OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS` | duration_ms | — | `5000` | — | — | Мягкий таймаут retrieval (частичные результаты), мс |
| `OPERATOR_RETRIEVAL_VECTOR_LIMIT` | int | — | `50` | — | — | Максимум кандидатов векторной стадии |
| `PAPER_MONITOR_MAX_WAIT_DAYS` | int | — | `7` | — | — | Дней ожидания paper-монитора до признания рана unresponsive |
| `PAPER_MONITOR_POLL_MS` | duration_ms | — | `21600000` | — | — | Интервал self-reschedule-опросов paper.monitor, мс (6 часов) |
| `PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD` | int | — | `15` | — | — | Сделок для закрытия paper-окна на PAPER_WINDOW_MAX_DAYS с пометкой low-confidence |
| `PAPER_WINDOW_MAX_DAYS` | int | — | `30` | — | — | Дней, после которых paper-окно форсирует вердикт |
| `PAPER_WINDOW_MIN_DAYS` | int | — | `3` | — | — | Минимум дней до возможного завершения paper-окна |
| `PAPER_WINDOW_MIN_TRADES` | int | — | `30` | — | — | Сделок для закрытия paper-окна с полной уверенностью |
| `PHOENIX_API_KEY` | string | — | — | да | — | Bearer-токен REST API Phoenix (self-hosted дефолт: нет) |
| `PHOENIX_COLLECTOR_ENDPOINT` | url | — | `http://localhost:6006/v1/traces` | — | — | OTLP HTTP-эндпоинт Phoenix-коллектора (docker: http://phoenix:6006/v1/traces) |
| `PHOENIX_ENABLED` | bool | — | `false` | — | — | Экспорт Mastra-трейсов в self-hosted Phoenix |
| `PHOENIX_PROJECT_NAME` | string | — | `trading-lab` | — | — | Имя Phoenix-проекта / OTel serviceName |
| `PHOENIX_READ_BASE_URL` | url | — | — | — | — | REST read-база Phoenix (без завершающего слэша); по умолчанию выводится из PHOENIX_COLLECTOR_ENDPOINT минус /v1/traces |
| `PLATFORM_RUN_MAX_POLLS` | int | — | `30` | — | — | Максимум опросов статуса backtester-рана |
| `PLATFORM_RUN_POLL_DELAY_MS` | duration_ms | — | `2000` | — | — | Задержка между опросами статуса backtester-рана, мс |
| `READ_API_PORT` | int | — | `3100` | — | — | Порт read-API |
| `REDIS_URL` | url | — | — | да | — | Redis connection string для BullMQ-очередей (может нести креды — secret) |
| `RESEARCHER_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер researcher: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `RESEARCHER_MAX_PER_PASS` | int | — | `5` | — | — | Максимум элементов на researcher-проход (прямое чтение в research-run-cycle.handler) |
| `RESEARCHER_MODEL` | string | — | `anthropic/claude-sonnet-4-6` | — | — | Модель researcher-агента |
| `RESEARCH_GRID_CONCURRENCY` | int | — | `4` | — | — | Максимум одновременных grid-точек на WFO-раунд (самоограничение lab) |
| `RESEARCH_TASK_TOKEN_BUDGET` | int | — | `200000` | — | — | Кумулятивный токен-бюджет research-цепочки (correlationId); 0 = безлимит |
| `REVISION_BATCH_MAX` | int | — | `5` | — | — | Максимум гипотез в одном strategy_revision-кандидате |
| `RUN_LLM_TESTS` | bool | — | `false` | — | — | Включает LLM-тесты, требующие реальных ключей |
| `STRATEGY_ANALYST_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер strategy-analyst: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `STRATEGY_ANALYST_MODEL` | string | — | `openrouter/openai/gpt-5.5` | — | — | Модель strategy-analyst (вердикт analyst:eval) |
| `STRATEGY_CRITIC_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер strategy-critic: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `STRATEGY_CRITIC_MODE` | enum(single, two_stage) | — | `single` | — | — | Режим критика: single (один агент) или two_stage (critic → refiner) |
| `STRATEGY_CRITIC_MODEL` | string | — | `openrouter/x-ai/grok-4.3` | — | — | Модель critic/combined-агента |
| `STRATEGY_PREFLIGHT_CRITIQUE` | bool | — | `true` | — | — | Pre-flight критика стратегии перед аналитиком |
| `STRATEGY_REFINER_MODEL` | string | — | — | — | — | Модель refiner-агента (two_stage); по умолчанию равна STRATEGY_CRITIC_MODEL |
| `TRADE_CONTEXT_TAIL_MIN` | int | — | `60` | — | — | Tail-окно trade-контекста, минут (прямое чтение в research-run-cycle.handler) |
| `TRADE_CONTEXT_WARMUP_MIN` | int | — | `150` | — | — | Warmup-окно trade-контекста, минут (прямое чтение в research-run-cycle.handler — хвост, см. roadmap env-catalog) |
| `TRADE_CONTEXT_WINNERS_MAX` | int | — | `5` | — | — | Максимум выигрышных сделок в trade-контексте (прямое чтение в research-run-cycle.handler) |
| `TRADING_LAB_CALLBACK_PUBLIC_URL` | url | — | — | — | — | Публичный базовый URL ingress (без завершающего слэша) для построения webhook-URL завершения бэктеста |
| `TRADING_LAB_CALLBACK_TOKEN` | string | — | — | да | — | Bearer-токен callback-эндпоинта завершения бэктестов |
| `TRADING_LAB_CHAT_TOKEN` | string | — | — | да | — | Bearer-токен chat-API lab |
| `TRADING_LAB_READ_TOKEN` | string | — | — | да | — | Bearer-токен read-API lab |
| `TRADING_LAB_TASK_TOKEN` | string | — | — | да | — | Bearer-токен task-API lab |
| `TRADING_PLATFORM_BASELINE_VERSION` | string | — | `v1` | — | — | Версия baseline-контракта research-платформы |
| `TRADING_PLATFORM_INTEGRATION` | enum(mock, backtester) | — | `mock` | — | — | Research-транспорт: mock или реальный backtester (fail-closed: опечатка — ошибка старта) |
| `TURN_INTERPRETER_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер turn-interpreter: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `TURN_INTERPRETER_MIN_CONFIDENCE` | float | — | `0.6` | — | — | Минимальная уверенность turn-interpreter для принятия интерпретации |
| `TURN_INTERPRETER_MODEL` | string | — | `openrouter/google/gemini-3.1-flash-lite` | — | — | Модель turn-interpreter |
| `WFO_GATE1_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер WFO Gate1: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `WFO_GATE1_MODEL` | string | — | `anthropic/claude-sonnet-4-6` | — | — | Модель WFO Gate1-агента |
| `WFO_RESULT_INTERPRETER_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер WFO result-interpreter: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `WFO_RESULT_INTERPRETER_MODEL` | string | — | `anthropic/claude-sonnet-4-6` | — | — | Модель WFO result-interpreter-агента |
| `WFO_SWEEP_DESIGNER_ADAPTER` | enum(fake, mastra) | — | — | — | — | Адаптер WFO sweep-designer: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта) |
| `WFO_SWEEP_DESIGNER_MODEL` | string | — | `anthropic/claude-sonnet-4-6` | — | — | Модель WFO sweep-designer-агента |
