// Декларативная env-схема репо trading-lab — контракт `env-schema.1`
// (env-catalog item 4; нормативный документ: control-center
// docs/architecture/contracts/env-schema.md + scripts/src/contracts/env-schema-1.schema.json).
//
// Единый источник метаданных для каждой переменной окружения, которую читает
// репо. Парсинг/fail-fast остаётся в loadEnv (src/config/env.ts) — этот модуль
// его НЕ заменяет, а описывает: тип, дефолт, secret/flag, владелец, точки
// чтения. Машинный экспорт — `pnpm env:schema` (stdout, детерминированный
// JSON); человекочитаемый — `pnpm env:docs` (ENV.md).
//
// Инварианты (пинуются src/config/env-schema.test.ts):
// - variables отсортированы по name, имена уникальны;
// - secret ⇒ default null (схема описывает форму, никогда значение);
// - required ⇒ default null;
// - flag ⇒ flag_states ⊆ [off, log, enforce], default_state ∈ flag_states,
//   default == default_state, флаг не required;
// - дефолты схемы совпадают с фактическим поведением loadEnv({}).

import { MODEL_PROVIDERS } from '../adapters/llm/model-provider.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../validation/evaluator.ts';
import { DEFAULT_PRESERVATION_THRESHOLDS } from '../validation/trade-preservation.ts';

export const ENV_SCHEMA_VERSION = 'env-schema.1' as const;

export const ENV_VARIABLE_TYPES = ['string', 'int', 'float', 'bool', 'enum', 'url', 'duration_ms', 'csv'] as const;
export type EnvVariableType = (typeof ENV_VARIABLE_TYPES)[number];

export const FLAG_STATES = ['off', 'log', 'enforce'] as const;
export type FlagState = (typeof FLAG_STATES)[number];

export interface EnvVariableSpec {
  name: string;
  type: EnvVariableType;
  required: boolean;
  /** Строковая форма как в .env; null = дефолта нет. Всегда null для secret и required. */
  default: string | null;
  description: string;
  secret: boolean;
  flag: boolean;
  /** iff type === 'enum'. */
  enum_values?: string[];
  /** iff flag === true; подмножество FLAG_STATES. */
  flag_states?: FlagState[];
  /** iff flag === true; обязан входить в flag_states. */
  default_state?: FlagState;
  owner_unit: string;
  consumers: string[];
}

export interface EnvSchemaDocument {
  schema_version: typeof ENV_SCHEMA_VERSION;
  repo: string;
  generated_from: string;
  variables: EnvVariableSpec[];
}

/** Логический юнит-владелец: lab деплоится как compose-юнит U6 (migrate/ingress/worker, F5a). */
const U6 = 'lab-u6';
const ENV_TS = 'src/config/env.ts';

interface SpecInput {
  name: string;
  type: EnvVariableType;
  description: string;
  default?: string | null;
  required?: boolean;
  secret?: boolean;
  flag?: boolean;
  enum_values?: string[];
  flag_states?: FlagState[];
  default_state?: FlagState;
  consumers?: string[];
}

/** Фиксированный порядок ключей — детерминированный JSON-экспорт (drift-гейт сравнивает diff'ом). */
function v(input: SpecInput): EnvVariableSpec {
  const spec: EnvVariableSpec = {
    name: input.name,
    type: input.type,
    required: input.required ?? false,
    default: input.default ?? null,
    description: input.description,
    secret: input.secret ?? false,
    flag: input.flag ?? false,
    ...(input.enum_values !== undefined ? { enum_values: input.enum_values } : {}),
    ...(input.flag_states !== undefined ? { flag_states: input.flag_states } : {}),
    ...(input.default_state !== undefined ? { default_state: input.default_state } : {}),
    owner_unit: U6,
    consumers: input.consumers ?? [ENV_TS],
  };
  return spec;
}

const ADAPTER_VALUES = ['fake', 'mastra'];

/** Агентный адаптер: дефолт наследуется от LAB_AGENTS_ADAPTER (поэтому default null). */
function adapterVar(name: string, what: string): EnvVariableSpec {
  return v({
    name,
    type: 'enum',
    enum_values: ADAPTER_VALUES,
    description: `Адаптер ${what}: fake (без ключей) или mastra (реальный LLM); дефолт наследуется от LAB_AGENTS_ADAPTER (fail-closed: неизвестное значение — ошибка старта)`,
    default: null,
  });
}

function secretVar(name: string, description: string, consumers?: string[]): EnvVariableSpec {
  return v({ name, type: 'string', secret: true, description, consumers });
}

const ED = DEFAULT_EVALUATOR_THRESHOLDS;
const PD = DEFAULT_PRESERVATION_THRESHOLDS;

const VARIABLES: EnvVariableSpec[] = [
  // --- ядро процесса (loadEnv) ---
  v({ name: 'DATABASE_URL', type: 'url', secret: true, description: 'PostgreSQL connection string (несёт креды — secret); без неё персистентные адаптеры не собираются' }),
  v({ name: 'REDIS_URL', type: 'url', secret: true, description: 'Redis connection string для BullMQ-очередей (может нести креды — secret)' }),
  v({ name: 'ARTIFACT_DIR', type: 'string', default: '.artifacts', description: 'Каталог артефактов исследований (бандлы, отчёты)' }),
  v({ name: 'ENABLE_CRITIC_AGENT', type: 'bool', default: 'false', description: 'Включает critic-агента в research-цикле' }),
  v({ name: 'INGRESS_PORT', type: 'int', default: '3000', description: 'Порт HTTP ingress-сервера' }),
  v({ name: 'READ_API_PORT', type: 'int', default: '3100', description: 'Порт read-API' }),
  secretVar('TRADING_LAB_READ_TOKEN', 'Bearer-токен read-API lab'),
  secretVar('TRADING_LAB_CHAT_TOKEN', 'Bearer-токен chat-API lab'),
  secretVar('TRADING_LAB_TASK_TOKEN', 'Bearer-токен task-API lab'),
  secretVar('TRADING_LAB_CALLBACK_TOKEN', 'Bearer-токен callback-эндпоинта завершения бэктестов'),
  v({ name: 'TRADING_LAB_CALLBACK_PUBLIC_URL', type: 'url', description: 'Публичный базовый URL ingress (без завершающего слэша) для построения webhook-URL завершения бэктеста' }),
  v({ name: 'TRADING_PLATFORM_INTEGRATION', type: 'enum', enum_values: ['mock', 'backtester'], default: 'mock', description: 'Research-транспорт: mock или реальный backtester (fail-closed: опечатка — ошибка старта)' }),
  v({ name: 'BACKTESTER_API_URL', type: 'url', description: 'Базовый URL API бэктестера; селекторы run-trades/research-platform подставляют http://127.0.0.1:8080 при отсутствии', consumers: [ENV_TS, 'src/adapters/platform/select-run-trades.ts', 'src/adapters/platform/select-research-platform.ts'] }),
  secretVar('BACKTESTER_API_TOKEN', 'Bearer-токен API бэктестера', [ENV_TS, 'src/adapters/platform/select-run-trades.ts', 'src/adapters/platform/select-research-platform.ts']),
  v({ name: 'PLATFORM_RUN_MAX_POLLS', type: 'int', default: '30', description: 'Максимум опросов статуса backtester-рана' }),
  v({ name: 'PLATFORM_RUN_POLL_DELAY_MS', type: 'duration_ms', default: '2000', description: 'Задержка между опросами статуса backtester-рана, мс' }),
  v({ name: 'TRADING_PLATFORM_BASELINE_VERSION', type: 'string', default: 'v1', description: 'Версия baseline-контракта research-платформы' }),
  v({ name: 'RESEARCH_GRID_CONCURRENCY', type: 'int', default: '4', description: 'Максимум одновременных grid-точек на WFO-раунд (самоограничение lab)' }),
  v({ name: 'LAB_QUEUE_CONCURRENCY', type: 'int', default: '1', description: 'Конкурентность BullMQ-воркера research-задач' }),
  v({ name: 'LAB_REVISION_QUEUE_CONCURRENCY', type: 'int', default: '1', description: 'Конкурентность очереди revision-оценок' }),
  v({ name: 'LAB_PG_POOL_MAX', type: 'int', default: '10', description: 'Максимальный размер пула PostgreSQL-соединений' }),
  v({ name: 'LAB_AGENTS_ADAPTER', type: 'enum', enum_values: ADAPTER_VALUES, default: 'fake', description: 'Общий дефолт всех агентных адаптеров (fake/mastra); частные *_ADAPTER переопределяют (fail-closed)' }),
  adapterVar('STRATEGY_ANALYST_ADAPTER', 'strategy-analyst'),
  v({ name: 'STRATEGY_ANALYST_MODEL', type: 'string', default: 'openrouter/openai/gpt-5.5', description: 'Модель strategy-analyst (вердикт analyst:eval)' }),
  secretVar('ANTHROPIC_API_KEY', 'API-ключ Anthropic (LLM-провайдер anthropic)'),
  v({ name: 'RUN_LLM_TESTS', type: 'bool', default: 'false', description: 'Включает LLM-тесты, требующие реальных ключей' }),
  adapterVar('RESEARCHER_ADAPTER', 'researcher'),
  v({ name: 'RESEARCHER_MODEL', type: 'string', default: 'anthropic/claude-sonnet-4-6', description: 'Модель researcher-агента' }),
  adapterVar('CRITIC_ADAPTER', 'critic'),
  v({ name: 'CRITIC_MODEL', type: 'string', default: 'anthropic/claude-sonnet-4-6', description: 'Модель critic-агента' }),
  v({ name: 'MAX_HYPOTHESES_PER_CYCLE', type: 'int', default: '5', description: 'Максимум гипотез на research-цикл' }),
  adapterVar('BUILDER_ADAPTER', 'builder'),
  v({ name: 'BUILDER_MODEL', type: 'string', default: 'anthropic/claude-sonnet-4-6', description: 'Модель builder-агента' }),
  v({ name: 'EVAL_MIN_TRADES', type: 'int', default: String(ED.minTrades), description: 'Порог оценщика: минимум сделок' }),
  v({ name: 'EVAL_MIN_PNL_DELTA_USD', type: 'float', default: String(ED.minPnlDeltaUsd), description: 'Порог оценщика: минимальная дельта PnL, USD' }),
  v({ name: 'EVAL_MAX_DRAWDOWN_TOLERANCE_PCT', type: 'float', default: String(ED.maxDrawdownTolerancePct), description: 'Порог оценщика: допуск по просадке, %' }),
  v({ name: 'EVAL_FRAGILITY_TOP_TRADE_PCT', type: 'float', default: String(ED.fragilityTopTradePct), description: 'Порог оценщика: доля топ-сделки (fragility), %' }),
  v({ name: 'EVAL_STRONG_PNL_DELTA_USD', type: 'float', default: String(ED.strongPnlDeltaUsd), description: 'Порог оценщика: сильная дельта PnL, USD' }),
  v({ name: 'EVAL_MIN_PROFIT_FACTOR', type: 'float', default: String(ED.minProfitFactor), description: 'Порог оценщика: минимальный profit factor' }),
  v({ name: 'LAB_TRADE_PRESERVATION_GATE', type: 'enum', enum_values: ['on', 'off'], default: 'on', description: 'Kill-switch trade-preservation-гейта; выключается только явным off' }),
  v({ name: 'LAB_TRADE_PRESERVATION_WINNER_RETENTION', type: 'float', default: String(PD.winnerRetention), description: 'Trade-preservation: доля сохранённых выигрышных сделок' }),
  v({ name: 'LAB_TRADE_PRESERVATION_MAX_TRADE_DROP_PCT', type: 'float', default: String(PD.maxTradeDropPct), description: 'Trade-preservation: максимум потери сделок, %' }),
  v({ name: 'LAB_TRADE_PRESERVATION_ABSTENTION_SHARE', type: 'float', default: String(PD.abstentionShare), description: 'Trade-preservation: допустимая доля воздержаний' }),
  v({ name: 'LAB_TRADE_PRESERVATION_EOD_SHARE', type: 'float', default: String(PD.eodShare), description: 'Trade-preservation: допустимая доля EOD-закрытий' }),
  v({ name: 'LAB_TRADE_PRESERVATION_MATCH_TOLERANCE_MS', type: 'float', default: String(PD.matchToleranceMs), description: 'Trade-preservation: допуск сопоставления сделок, мс' }),
  v({ name: 'LAB_TRADE_PRESERVATION_MIN_WINNER_SAMPLE', type: 'float', default: String(PD.minWinnerSample), description: 'Trade-preservation: минимальная выборка выигрышных сделок' }),
  v({ name: 'MODEL_PROVIDER', type: 'enum', enum_values: [...MODEL_PROVIDERS], default: 'anthropic', description: 'LLM-провайдер по умолчанию (неизвестное значение тихо откатывается к anthropic)', consumers: [ENV_TS, 'src/experiments/turn-interpreter/report.ts'] }),
  secretVar('OPENAI_API_KEY', 'API-ключ OpenAI (LLM-провайдер openai)'),
  secretVar('OPENROUTER_API_KEY', 'API-ключ OpenRouter (LLM-провайдер openrouter, embeddings)'),
  adapterVar('TURN_INTERPRETER_ADAPTER', 'turn-interpreter'),
  v({ name: 'TURN_INTERPRETER_MODEL', type: 'string', default: 'openrouter/google/gemini-3.1-flash-lite', description: 'Модель turn-interpreter' }),
  v({ name: 'TURN_INTERPRETER_MIN_CONFIDENCE', type: 'float', default: '0.6', description: 'Минимальная уверенность turn-interpreter для принятия интерпретации' }),
  v({ name: 'CHAT_MAX_MESSAGE_CHARS', type: 'int', default: '4000', description: 'Максимальная длина chat-сообщения, символов' }),
  v({ name: 'CHAT_RATE_MAX_TURNS', type: 'int', default: '30', description: 'Rate-limit: максимум chat-ходов на окно на инстанс (0 = выключен)' }),
  v({ name: 'CHAT_RATE_WINDOW_MS', type: 'duration_ms', default: '60000', description: 'Rate-limit: окно подсчёта chat-ходов, мс' }),
  v({ name: 'AGENT_ACTIVITY_REBUILD_WINDOW_HOURS', type: 'int', default: '24', description: 'Окно перестроения ленты агентной активности, часов' }),
  v({ name: 'AGENT_ACTIVITY_TRACE_LIMIT', type: 'int', default: '50', description: 'Максимум трейсов в ленте агентной активности' }),
  v({ name: 'AGENT_EVENT_STREAM_SAFETY_TICK_MS', type: 'duration_ms', default: '5000', description: 'Safety-tick SSE-потока агентных событий, мс' }),
  v({ name: 'AGENT_EVENT_STREAM_HEARTBEAT_MS', type: 'duration_ms', default: '15000', description: 'Heartbeat SSE-потока агентных событий, мс' }),
  v({ name: 'PHOENIX_ENABLED', type: 'bool', default: 'false', description: 'Экспорт Mastra-трейсов в self-hosted Phoenix' }),
  v({ name: 'PHOENIX_COLLECTOR_ENDPOINT', type: 'url', default: 'http://localhost:6006/v1/traces', description: 'OTLP HTTP-эндпоинт Phoenix-коллектора (docker: http://phoenix:6006/v1/traces)' }),
  v({ name: 'PHOENIX_PROJECT_NAME', type: 'string', default: 'trading-lab', description: 'Имя Phoenix-проекта / OTel serviceName' }),
  v({ name: 'PHOENIX_READ_BASE_URL', type: 'url', description: 'REST read-база Phoenix (без завершающего слэша); по умолчанию выводится из PHOENIX_COLLECTOR_ENDPOINT минус /v1/traces' }),
  secretVar('PHOENIX_API_KEY', 'Bearer-токен REST API Phoenix (self-hosted дефолт: нет)'),
  v({ name: 'RESEARCH_TASK_TOKEN_BUDGET', type: 'int', default: '200000', description: 'Кумулятивный токен-бюджет research-цепочки (correlationId); 0 = безлимит' }),
  v({ name: 'STRATEGY_PREFLIGHT_CRITIQUE', type: 'bool', default: 'true', description: 'Pre-flight критика стратегии перед аналитиком' }),
  adapterVar('STRATEGY_CRITIC_ADAPTER', 'strategy-critic'),
  v({ name: 'STRATEGY_CRITIC_MODE', type: 'enum', enum_values: ['single', 'two_stage'], default: 'single', description: 'Режим критика: single (один агент) или two_stage (critic → refiner)' }),
  v({ name: 'STRATEGY_CRITIC_MODEL', type: 'string', default: 'openrouter/x-ai/grok-4.3', description: 'Модель critic/combined-агента' }),
  v({ name: 'STRATEGY_REFINER_MODEL', type: 'string', description: 'Модель refiner-агента (two_stage); по умолчанию равна STRATEGY_CRITIC_MODEL' }),
  adapterVar('WFO_GATE1_ADAPTER', 'WFO Gate1'),
  v({ name: 'WFO_GATE1_MODEL', type: 'string', default: 'anthropic/claude-sonnet-4-6', description: 'Модель WFO Gate1-агента' }),
  adapterVar('WFO_SWEEP_DESIGNER_ADAPTER', 'WFO sweep-designer'),
  v({ name: 'WFO_SWEEP_DESIGNER_MODEL', type: 'string', default: 'anthropic/claude-sonnet-4-6', description: 'Модель WFO sweep-designer-агента' }),
  adapterVar('WFO_RESULT_INTERPRETER_ADAPTER', 'WFO result-interpreter'),
  v({ name: 'WFO_RESULT_INTERPRETER_MODEL', type: 'string', default: 'anthropic/claude-sonnet-4-6', description: 'Модель WFO result-interpreter-агента' }),
  v({ name: 'OPERATOR_RAG_ENABLED', type: 'bool', default: 'false', description: 'Включает operator-RAG-retrieval' }),
  v({ name: 'OPERATOR_EMBEDDING_MODEL', type: 'string', default: 'baai/bge-m3', description: 'Slug embedding-модели operator-retrieval' }),
  v({ name: 'OPERATOR_EMBEDDING_DIMENSIONS', type: 'int', default: '1024', description: 'Размерность эмбеддингов; поддержана только 1024 — любое другое значение валит старт (fail-fast)' }),
  v({ name: 'OPERATOR_RETRIEVAL_INDEX_VERSION', type: 'int', default: '1', description: 'Версия схемы retrieval-индекса' }),
  v({ name: 'OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS', type: 'duration_ms', default: '5000', description: 'Мягкий таймаут retrieval (частичные результаты), мс' }),
  v({ name: 'OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS', type: 'duration_ms', default: '10000', description: 'Жёсткий таймаут retrieval; обязан быть >= мягкого (fail-fast)' }),
  v({ name: 'OPERATOR_RETRIEVAL_LEXICAL_LIMIT', type: 'int', default: '50', description: 'Максимум кандидатов лексической (BM25) стадии' }),
  v({ name: 'OPERATOR_RETRIEVAL_VECTOR_LIMIT', type: 'int', default: '50', description: 'Максимум кандидатов векторной стадии' }),
  v({ name: 'OPERATOR_RETRIEVAL_FUSED_LIMIT', type: 'int', default: '20', description: 'Максимум кандидатов после fusion/re-rank' }),
  v({ name: 'OPERATOR_RERANKER', type: 'enum', enum_values: ['mastra', 'none'], default: 'none', description: 'Reranker-бэкенд: mastra (LLM) или none (порядок RRF)' }),
  v({ name: 'OPERATOR_RERANK_TIMEOUT_MS', type: 'duration_ms', default: '1500', description: 'Максимум ожидания reranker до отката к RRF, мс' }),
  v({ name: 'OPERATOR_RERANK_LIMIT', type: 'int', default: '5', description: 'Максимум кандидатов из reranker' }),
  v({ name: 'OPERATOR_RERANK_MIN_CANDIDATES', type: 'int', default: '10', description: 'Минимум кандидатов для объёмного reranking' }),
  v({ name: 'OPERATOR_RERANK_RRF_MARGIN', type: 'float', default: '0.002', description: 'RRF-порог неоднозначности: зазор топ-2 <= порога включает reranking' }),
  v({ name: 'PAPER_WINDOW_MIN_TRADES', type: 'int', default: '30', description: 'Сделок для закрытия paper-окна с полной уверенностью' }),
  v({ name: 'PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD', type: 'int', default: '15', description: 'Сделок для закрытия paper-окна на PAPER_WINDOW_MAX_DAYS с пометкой low-confidence' }),
  v({ name: 'PAPER_WINDOW_MIN_DAYS', type: 'int', default: '3', description: 'Минимум дней до возможного завершения paper-окна' }),
  v({ name: 'PAPER_WINDOW_MAX_DAYS', type: 'int', default: '30', description: 'Дней, после которых paper-окно форсирует вердикт' }),
  v({ name: 'PAPER_MONITOR_MAX_WAIT_DAYS', type: 'int', default: '7', description: 'Дней ожидания paper-монитора до признания рана unresponsive' }),
  v({ name: 'PAPER_MONITOR_POLL_MS', type: 'duration_ms', default: '21600000', description: 'Интервал self-reschedule-опросов paper.monitor, мс (6 часов)' }),
  v({ name: 'REVISION_BATCH_MAX', type: 'int', default: '5', description: 'Максимум гипотез в одном strategy_revision-кандидате' }),
  v({ name: 'LAB_PAPER_EVIDENCE_REQUIRED', type: 'bool', default: 'false', description: 'Fail-closed гейт: при true boot отказывает без не-none источника signed-evidence' }),
  v({ name: 'LAB_TRUSTED_SIGNERS_JSON', type: 'string', description: 'JSON-карта keyId -> SPKI PEM для верификации подписанной backtest-evidence; пусто = {}; невалидный JSON валит старт (fail-fast)' }),
  v({ name: 'CONSOLIDATOR_ADAPTER', type: 'enum', enum_values: ['off', 'fake', 'mastra'], default: 'off', description: 'LLM-консолидация (G3b); OFF если не включена явно — НЕ наследует LAB_AGENTS_ADAPTER' }),
  v({ name: 'CONSOLIDATOR_MODEL', type: 'string', default: 'openrouter/anthropic/claude-opus-4-8', description: 'Модель consolidator-агента (CONSOLIDATOR_ADAPTER=mastra)' }),
  v({ name: 'LAB_CONSOLIDATION_DEPTH_THRESHOLD', type: 'int', default: '2', description: 'Порог глубины вложенности, запускающий revision.consolidate; 0 = kill-switch' }),
  v({ name: 'LAB_CONSOLIDATION_TOL_REL', type: 'float', default: '0.001', description: 'Относительный допуск parity-гейта консолидации' }),
  v({ name: 'LAB_CONSOLIDATION_TOL_ABS', type: 'float', default: '0.01', description: 'Абсолютный допуск parity-гейта консолидации' }),
  v({
    name: 'LAB_BREAK_BATTERY_MODE',
    type: 'enum',
    enum_values: ['off', 'log'],
    flag: true,
    flag_states: ['off', 'log'],
    default_state: 'off',
    default: 'off',
    description: 'Флаг E4b-паттерна: режим раскатки break_battery@1 (R11). off — батарея не запускается; log — запускается, персистит и логирует, вердикты не меняет. Состояние enforce намеренно отклоняется резолвером до пиновки порогов владельцем (research-validation-hardening item 7)',
  }),
  v({
    name: 'LAB_HYPOTHESIS_HOLDOUT',
    type: 'enum',
    enum_values: ['off', 'log'],
    flag: true,
    flag_states: ['off', 'log'],
    default_state: 'off',
    default: 'off',
    description: 'Флаг E4b-паттерна (R12a, research-validation-hardening item 5): режим раскатки лёгкого holdout-подтверждения проксистатуса PAPER_CANDIDATE (task hypothesis.holdout), запускающего break_battery@1 (R11) на уровне гипотезы. off — holdout не enqueue-ится; log — enqueue-ится, персистит и логирует, вердикты не меняет. Состояние enforce намеренно отклоняется резолвером до калибровки порогов battery-policy@1',
  }),
  // --- селекторные оси (boot-safe селекторы читают свой env из composition.ts) ---
  v({ name: 'LAB_SIGNED_EVIDENCE_SOURCE', type: 'enum', enum_values: ['none', 'fixture', 'http'], default: 'none', description: 'Источник подписанной backtest-evidence; fixture вне NODE_ENV=test требует LAB_ALLOW_FIXTURE_EVIDENCE=true (fail-closed)', consumers: ['src/adapters/platform/select-signed-evidence.ts'] }),
  v({ name: 'LAB_ALLOW_FIXTURE_EVIDENCE', type: 'bool', default: 'false', description: 'Явное разрешение fixture-evidence вне NODE_ENV=test (self-signed, никогда для прод-гейтов)', consumers: ['src/adapters/platform/select-signed-evidence.ts'] }),
  v({ name: 'NODE_ENV', type: 'string', description: 'Стандартная нода-переменная; в lab читается только guard\'ом fixture-evidence (=== test)', consumers: ['src/adapters/platform/select-signed-evidence.ts'] }),
  v({ name: 'LAB_BOT_RESULTS_INTEGRATION', type: 'enum', enum_values: ['mock', 'fixture', 'http'], default: 'mock', description: 'Ось чтения bot-results/trade-evidence (отдельная от TRADING_PLATFORM_INTEGRATION; fail-closed)', consumers: ['src/adapters/platform/select-bot-results.ts', 'src/adapters/platform/select-trade-evidence.ts'] }),
  v({ name: 'LAB_OPS_READ_URL', type: 'url', description: 'Базовый URL ops-read-поверхности (bot-results/trade-evidence/market-history); фолбэк http://127.0.0.1:8839 в селекторах', consumers: ['src/adapters/platform/select-bot-results.ts', 'src/adapters/platform/select-trade-evidence.ts', 'src/adapters/platform/select-market-history.ts'] }),
  secretVar('LAB_OPS_READ_TOKEN', 'Bearer-токен ops-read-поверхности', ['src/adapters/platform/select-bot-results.ts', 'src/adapters/platform/select-trade-evidence.ts', 'src/adapters/platform/select-market-history.ts']),
  v({ name: 'LAB_OPS_READ_FIXTURE_DIR', type: 'string', description: 'Каталог фикстур для fixture-режима bot-results/trade-evidence; дефолт — встроенный каталог фикстур', consumers: ['src/adapters/platform/select-bot-results.ts', 'src/adapters/platform/select-trade-evidence.ts'] }),
  v({ name: 'LAB_MARKET_HISTORY_URL', type: 'url', description: 'URL market-history-поверхности; при отсутствии — LAB_OPS_READ_URL, затем http://mock-platform:8839', consumers: ['src/adapters/platform/select-market-history.ts'] }),
  v({ name: 'LAB_PAPER_INTAKE_URL', type: 'url', description: 'URL paper-intake платформы; не задана — интейк выключен (submit возвращает ошибку вызывателю)', consumers: ['src/adapters/platform/paper-intake.port.ts'] }),
  secretVar('LAB_PAPER_INTAKE_TOKEN', 'Bearer-токен paper-intake платформы', ['src/adapters/platform/paper-intake.port.ts']),
  // --- хвост прямых чтений research-run-cycle.handler (миграция на loadEnv — roadmap env-catalog) ---
  v({ name: 'TRADE_CONTEXT_WARMUP_MIN', type: 'int', default: '150', description: 'Warmup-окно trade-контекста, минут (прямое чтение в research-run-cycle.handler — хвост, см. roadmap env-catalog)', consumers: ['src/orchestrator/handlers/research-run-cycle.handler.ts'] }),
  v({ name: 'TRADE_CONTEXT_TAIL_MIN', type: 'int', default: '60', description: 'Tail-окно trade-контекста, минут (прямое чтение в research-run-cycle.handler)', consumers: ['src/orchestrator/handlers/research-run-cycle.handler.ts'] }),
  v({ name: 'TRADE_CONTEXT_WINNERS_MAX', type: 'int', default: '5', description: 'Максимум выигрышных сделок в trade-контексте (прямое чтение в research-run-cycle.handler)', consumers: ['src/orchestrator/handlers/research-run-cycle.handler.ts'] }),
  v({ name: 'MARKET_HISTORY_LOOKBACK_DAYS', type: 'int', default: '7', description: 'Lookback market-history для research-цикла, дней (прямое чтение в research-run-cycle.handler)', consumers: ['src/orchestrator/handlers/research-run-cycle.handler.ts'] }),
  v({ name: 'RESEARCHER_MAX_PER_PASS', type: 'int', default: '5', description: 'Максимум элементов на researcher-проход (прямое чтение в research-run-cycle.handler)', consumers: ['src/orchestrator/handlers/research-run-cycle.handler.ts'] }),
  // --- деплой-переменные (кодом не читаются) ---
  v({ name: 'LAB_U6_IMAGE', type: 'string', description: 'Деплой-переменная compose (юнит U6, F5a): digest-pinned образ lab (ghcr.io/trdlabs/lab@sha256:<64 hex>); обязательная интерполяция в docker-compose.vps.yml, кодом не читается', consumers: ['docker-compose.vps.yml', 'infra/scripts/unit-deploy.sh'] }),
];

export function envSchemaDocument(): EnvSchemaDocument {
  const variables = [...VARIABLES].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    schema_version: ENV_SCHEMA_VERSION,
    repo: 'trading-lab',
    generated_from: 'src/config/env.ts',
    variables,
  };
}

/** Детерминированный машинный экспорт: JSON, 2 пробела, завершающий \n (`pnpm env:schema`). */
export function renderEnvSchemaJson(): string {
  return JSON.stringify(envSchemaDocument(), null, 2) + '\n';
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** ENV.md — генерируется из схемы, руками не редактируется (`pnpm env:docs`). */
export function renderEnvMd(): string {
  const doc = envSchemaDocument();
  const lines: string[] = [
    '# ENV — trading-lab',
    '',
    '<!-- GENERATED FILE — не редактировать руками. Источник: src/config/env-schema.ts. -->',
    '<!-- Перегенерация: `pnpm env:docs`. Машинный экспорт: `pnpm env:schema`. -->',
    '',
    'Схема соответствует контракту `env-schema.1`',
    '(control-center, `docs/architecture/contracts/env-schema.md`).',
    'Значения секретов здесь не появляются никогда — только имя и форма;',
    'живые значения — в `.env.vps` на хостах и SOPS/age-контуре.',
    '',
    `Переменных: ${doc.variables.length}. Точка чтения — \`${doc.generated_from}\` (loadEnv) и явно перечисленные consumers.`,
    '',
    '| Имя | Тип | Обяз. | Default | Secret | Flag | Описание |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const v of doc.variables) {
    const type = v.type === 'enum' && v.enum_values ? `enum(${v.enum_values.join(', ')})` : v.type;
    const def = v.default === null ? '—' : `\`${v.default}\``;
    const flag = v.flag && v.flag_states && v.default_state ? `${v.flag_states.join('/')} → ${v.default_state}` : '—';
    lines.push(
      `| \`${v.name}\` | ${mdEscape(type)} | ${v.required ? 'да' : '—'} | ${mdEscape(def)} | ${v.secret ? 'да' : '—'} | ${flag} | ${mdEscape(v.description)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
