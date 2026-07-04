import { DEFAULT_EVALUATOR_THRESHOLDS, type EvaluatorThresholds } from '../validation/evaluator.ts';
import { MODEL_PROVIDERS, type ModelProvider } from '../adapters/llm/model-provider.ts';

export interface Env {
  DATABASE_URL?: string;
  REDIS_URL?: string;
  ARTIFACT_DIR: string;
  ENABLE_CRITIC_AGENT: boolean;
  INGRESS_PORT: number;
  READ_API_PORT: number;
  TRADING_LAB_READ_TOKEN?: string;
  TRADING_LAB_CHAT_TOKEN?: string;
  TRADING_LAB_TASK_TOKEN?: string;
  TRADING_LAB_CALLBACK_TOKEN?: string;
  /** Public base URL of ingress (no trailing slash) — used to build backtest completion webhook URL. */
  TRADING_LAB_CALLBACK_PUBLIC_URL?: string;
  TRADING_PLATFORM_INTEGRATION: 'mock' | 'backtester';
  BACKTESTER_API_URL?: string;
  BACKTESTER_API_TOKEN?: string;
  BACKTEST_BACKEND: 'research_platform';
  PLATFORM_RUN_MAX_POLLS: number;
  PLATFORM_RUN_POLL_DELAY_MS: number;
  TRADING_PLATFORM_BASELINE_VERSION: string;
  /** Max in-flight grid points per WFO round (lab self-limit; backtester has no ingress backpressure yet). */
  RESEARCH_GRID_CONCURRENCY: number;
  /** BullMQ worker concurrency — research tasks processed in parallel per lab process. */
  LAB_QUEUE_CONCURRENCY: number;
  STRATEGY_ANALYST_ADAPTER: 'fake' | 'mastra';
  STRATEGY_ANALYST_MODEL: string;
  ANTHROPIC_API_KEY?: string;
  RUN_LLM_TESTS: boolean;
  RESEARCHER_ADAPTER: 'fake' | 'mastra';
  RESEARCHER_MODEL: string;
  CRITIC_ADAPTER: 'fake' | 'mastra';
  CRITIC_MODEL: string;
  MAX_HYPOTHESES_PER_CYCLE: number;
  BUILDER_ADAPTER: 'fake' | 'mastra';
  BUILDER_MODEL: string;
  evaluatorThresholds: EvaluatorThresholds;
  MODEL_PROVIDER: ModelProvider;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  TURN_INTERPRETER_ADAPTER: 'fake' | 'mastra';
  TURN_INTERPRETER_MODEL: string;
  TURN_INTERPRETER_MIN_CONFIDENCE: number;
  CHAT_MAX_MESSAGE_CHARS: number;
  AGENT_ACTIVITY_REBUILD_WINDOW_HOURS: number;
  AGENT_ACTIVITY_TRACE_LIMIT: number;
  AGENT_EVENT_STREAM_SAFETY_TICK_MS: number;
  AGENT_EVENT_STREAM_HEARTBEAT_MS: number;
  /** Feature flag: export Mastra agent traces to a self-hosted Phoenix (default: false). */
  PHOENIX_ENABLED: boolean;
  /** Phoenix OTLP HTTP collector endpoint (default: http://localhost:6006/v1/traces; docker: http://phoenix:6006/v1/traces). */
  PHOENIX_COLLECTOR_ENDPOINT: string;
  /** Phoenix project name / OTel serviceName (default: trading-lab). */
  PHOENIX_PROJECT_NAME: string;
  /** Phoenix REST read base URL (no trailing slash). Defaults to PHOENIX_COLLECTOR_ENDPOINT minus /v1/traces, else http://localhost:6006. */
  PHOENIX_READ_BASE_URL: string;
  /** Optional Bearer token for the Phoenix REST API (self-hosted default: none). */
  PHOENIX_API_KEY?: string;
  /** Cumulative token budget per research chain (correlationId). Default 200000; 0 = unlimited. */
  RESEARCH_TASK_TOKEN_BUDGET: number;
  /** Feature flag: run the pre-flight strategy critic before the analyst (default: true; set 'false' to disable). */
  STRATEGY_PREFLIGHT_CRITIQUE: boolean;
  /** Strategy-critic adapter: 'fake' (default, key-free) or 'mastra' (real LLM). */
  STRATEGY_CRITIC_ADAPTER: 'fake' | 'mastra';
  /** Critic mode: 'single' (default; one combined agent) or 'two_stage' (critic agent → refiner agent). */
  STRATEGY_CRITIC_MODE: 'single' | 'two_stage';
  /** Model for the critic / combined agent. */
  STRATEGY_CRITIC_MODEL: string;
  /** Model for the two_stage refiner agent; defaults to STRATEGY_CRITIC_MODEL when unset. */
  STRATEGY_REFINER_MODEL: string;
  /** WFO Gate1 decision agent: 'fake' (default, key-free) or 'mastra' (real LLM). */
  WFO_GATE1_ADAPTER: 'fake' | 'mastra';
  /** Model for the WFO Gate1 decision agent. */
  WFO_GATE1_MODEL: string;
  /** WFO sweep-designer agent: 'fake' (default, key-free) or 'mastra' (real LLM). */
  WFO_SWEEP_DESIGNER_ADAPTER: 'fake' | 'mastra';
  /** Model for the WFO sweep-designer agent. */
  WFO_SWEEP_DESIGNER_MODEL: string;
  /** WFO result-interpreter agent: 'fake' (default, key-free) or 'mastra' (real LLM). */
  WFO_RESULT_INTERPRETER_ADAPTER: 'fake' | 'mastra';
  /** Model for the WFO result-interpreter agent. */
  WFO_RESULT_INTERPRETER_MODEL: string;
  /** Feature flag: enable operator RAG retrieval (default: false). */
  OPERATOR_RAG_ENABLED: boolean;
  /** Embedding provider for operator strategy retrieval (default: 'openrouter'). */
  OPERATOR_EMBEDDING_PROVIDER: 'openrouter';
  /** Embedding model slug (default: 'baai/bge-m3'). */
  OPERATOR_EMBEDDING_MODEL: string;
  /** Embedding output dimensions — only 1024 supported; loadEnv throws on any other value. */
  OPERATOR_EMBEDDING_DIMENSIONS: 1024;
  /** Retrieval index schema version (default: 1). */
  OPERATOR_RETRIEVAL_INDEX_VERSION: number;
  /** Soft retrieval timeout in ms — return partial results (default: 5000). */
  OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS: number;
  /** Hard retrieval timeout in ms — abort entirely; must be >= soft (default: 10000). */
  OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS: number;
  /** Max candidates from lexical (BM25) stage (default: 50). */
  OPERATOR_RETRIEVAL_LEXICAL_LIMIT: number;
  /** Max candidates from vector stage (default: 50). */
  OPERATOR_RETRIEVAL_VECTOR_LIMIT: number;
  /** Max candidates after fusion/re-rank stage (default: 20). */
  OPERATOR_RETRIEVAL_FUSED_LIMIT: number;
  /** Reranker backend — 'mastra' enables LLM reranking; 'none' (default) keeps RRF order. */
  OPERATOR_RERANKER: 'mastra' | 'none';
  /** Max ms to wait for reranker before falling back to RRF order (default: 1500). */
  OPERATOR_RERANK_TIMEOUT_MS: number;
  /** Max candidates to return from reranker (default: 5). */
  OPERATOR_RERANK_LIMIT: number;
  /** Minimum candidate count to trigger volume-based reranking (default: 10). */
  OPERATOR_RERANK_MIN_CANDIDATES: number;
  /** RRF ambiguity margin — top-two gap <= this triggers reranking (default: 0.002). */
  OPERATOR_RERANK_RRF_MARGIN: number;
  /** Trade count that closes the paper observation window with full confidence (default: 30). */
  PAPER_WINDOW_MIN_TRADES: number;
  /** At PAPER_WINDOW_MAX_DAYS, this many closed trades still closes the window, flagged low-confidence (default: 15). */
  PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD: number;
  /** Minimum elapsed days before the paper window can ever complete (default: 3). */
  PAPER_WINDOW_MIN_DAYS: number;
  /** Elapsed days at which the paper window forces a verdict (default: 30). */
  PAPER_WINDOW_MAX_DAYS: number;
  /** Max days the paper monitor waits before treating a run as unresponsive (default: 7). */
  PAPER_MONITOR_MAX_WAIT_DAYS: number;
  /** Delay (ms) between paper.monitor self-reschedule polls (default: 21600000 — 6 hours). */
  PAPER_MONITOR_POLL_MS: number;
  /** Max eligible hypotheses batched into one strategy_revision candidate (default: 5). */
  REVISION_BATCH_MAX: number;
  /** Fail-closed gate: when true, boot refuses unless a non-'none' signed-evidence source is available (default: false). */
  LAB_PAPER_EVIDENCE_REQUIRED: boolean;
  /** keyId -> SPKI PEM map for verifying signed backtest evidence; parsed from JSON (default: {}). */
  LAB_TRUSTED_SIGNERS_JSON: Record<string, string>;
}

function parseModelProvider(value: string | undefined): ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value ?? '') ? (value as ModelProvider) : 'anthropic';
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function parseFloatOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Parses LAB_TRUSTED_SIGNERS_JSON: {} on undefined/empty; throws on invalid JSON or non-string values. */
export function parseTrustedSigners(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`LAB_TRUSTED_SIGNERS_JSON must be valid JSON, got '${raw}'`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LAB_TRUSTED_SIGNERS_JSON must be a flat JSON object of keyId -> PEM strings');
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`LAB_TRUSTED_SIGNERS_JSON value for '${key}' must be a string, got ${typeof value}`);
    }
  }
  return parsed as Record<string, string>;
}

function derivePhoenixReadBaseUrl(source: NodeJS.ProcessEnv): string {
  const explicit = source.PHOENIX_READ_BASE_URL;
  if (explicit && explicit.trim() !== '') return explicit.replace(/\/+$/, '');
  const collector = source.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006/v1/traces';
  return collector.replace(/\/v1\/traces\/?$/, '').replace(/\/+$/, '') || 'http://localhost:6006';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const agentsDefault: 'fake' | 'mastra' = source.LAB_AGENTS_ADAPTER === 'mastra' ? 'mastra' : 'fake';
  const resolveAdapter = (v: string | undefined): 'fake' | 'mastra' =>
    v === 'mastra' ? 'mastra' : v === 'fake' ? 'fake' : agentsDefault;
  const strategyCriticModel = source.STRATEGY_CRITIC_MODEL || 'openrouter/x-ai/grok-4.3';

  return {
    DATABASE_URL: source.DATABASE_URL,
    REDIS_URL: source.REDIS_URL,
    ARTIFACT_DIR: source.ARTIFACT_DIR ?? '.artifacts',
    ENABLE_CRITIC_AGENT: source.ENABLE_CRITIC_AGENT === 'true',
    INGRESS_PORT: parsePort(source.INGRESS_PORT, 3000),
    READ_API_PORT: parsePort(source.READ_API_PORT, 3100),
    TRADING_LAB_READ_TOKEN: source.TRADING_LAB_READ_TOKEN,
    TRADING_LAB_CHAT_TOKEN: source.TRADING_LAB_CHAT_TOKEN,
    TRADING_LAB_TASK_TOKEN: source.TRADING_LAB_TASK_TOKEN,
    TRADING_LAB_CALLBACK_TOKEN: source.TRADING_LAB_CALLBACK_TOKEN,
    TRADING_LAB_CALLBACK_PUBLIC_URL: source.TRADING_LAB_CALLBACK_PUBLIC_URL,
    TRADING_PLATFORM_INTEGRATION:
      source.TRADING_PLATFORM_INTEGRATION === 'backtester' ? 'backtester' : 'mock',
    BACKTESTER_API_URL: source.BACKTESTER_API_URL,
    BACKTESTER_API_TOKEN: source.BACKTESTER_API_TOKEN,
    BACKTEST_BACKEND: 'research_platform',
    PLATFORM_RUN_MAX_POLLS: parsePositiveInt(source.PLATFORM_RUN_MAX_POLLS, 30),
    PLATFORM_RUN_POLL_DELAY_MS: parsePositiveInt(source.PLATFORM_RUN_POLL_DELAY_MS, 2000),
    TRADING_PLATFORM_BASELINE_VERSION: source.TRADING_PLATFORM_BASELINE_VERSION ?? 'v1',
    RESEARCH_GRID_CONCURRENCY: parsePositiveInt(source.RESEARCH_GRID_CONCURRENCY, 4),
    LAB_QUEUE_CONCURRENCY: parsePositiveInt(source.LAB_QUEUE_CONCURRENCY, 1),
    STRATEGY_ANALYST_ADAPTER: resolveAdapter(source.STRATEGY_ANALYST_ADAPTER),
    STRATEGY_ANALYST_MODEL: source.STRATEGY_ANALYST_MODEL ?? 'openrouter/openai/gpt-5.5',
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
    RUN_LLM_TESTS: source.RUN_LLM_TESTS === 'true',
    RESEARCHER_ADAPTER: resolveAdapter(source.RESEARCHER_ADAPTER),
    RESEARCHER_MODEL: source.RESEARCHER_MODEL ?? 'anthropic/claude-sonnet-4-6',
    CRITIC_ADAPTER: resolveAdapter(source.CRITIC_ADAPTER),
    CRITIC_MODEL: source.CRITIC_MODEL ?? 'anthropic/claude-sonnet-4-6',
    MAX_HYPOTHESES_PER_CYCLE: parsePositiveInt(source.MAX_HYPOTHESES_PER_CYCLE, 5),
    BUILDER_ADAPTER: resolveAdapter(source.BUILDER_ADAPTER),
    BUILDER_MODEL: source.BUILDER_MODEL ?? 'anthropic/claude-sonnet-4-6',
    evaluatorThresholds: {
      minTrades: parsePositiveInt(source.EVAL_MIN_TRADES, DEFAULT_EVALUATOR_THRESHOLDS.minTrades),
      minPnlDeltaUsd: parseFloatOr(source.EVAL_MIN_PNL_DELTA_USD, DEFAULT_EVALUATOR_THRESHOLDS.minPnlDeltaUsd),
      maxDrawdownTolerancePct: parseFloatOr(source.EVAL_MAX_DRAWDOWN_TOLERANCE_PCT, DEFAULT_EVALUATOR_THRESHOLDS.maxDrawdownTolerancePct),
      fragilityTopTradePct: parseFloatOr(source.EVAL_FRAGILITY_TOP_TRADE_PCT, DEFAULT_EVALUATOR_THRESHOLDS.fragilityTopTradePct),
      strongPnlDeltaUsd: parseFloatOr(source.EVAL_STRONG_PNL_DELTA_USD, DEFAULT_EVALUATOR_THRESHOLDS.strongPnlDeltaUsd),
      minProfitFactor: parseFloatOr(source.EVAL_MIN_PROFIT_FACTOR, DEFAULT_EVALUATOR_THRESHOLDS.minProfitFactor),
    },
    MODEL_PROVIDER: parseModelProvider(source.MODEL_PROVIDER),
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    OPENROUTER_API_KEY: source.OPENROUTER_API_KEY,
    TURN_INTERPRETER_ADAPTER: resolveAdapter(source.TURN_INTERPRETER_ADAPTER),
    TURN_INTERPRETER_MODEL: source.TURN_INTERPRETER_MODEL ?? 'openrouter/google/gemini-3.1-flash-lite',
    TURN_INTERPRETER_MIN_CONFIDENCE: parseFloatOr(source.TURN_INTERPRETER_MIN_CONFIDENCE, 0.6),
    CHAT_MAX_MESSAGE_CHARS: parsePositiveInt(source.CHAT_MAX_MESSAGE_CHARS, 4000),
    AGENT_ACTIVITY_REBUILD_WINDOW_HOURS: parsePositiveInt(source.AGENT_ACTIVITY_REBUILD_WINDOW_HOURS, 24),
    AGENT_ACTIVITY_TRACE_LIMIT: parsePositiveInt(source.AGENT_ACTIVITY_TRACE_LIMIT, 50),
    AGENT_EVENT_STREAM_SAFETY_TICK_MS: parsePositiveInt(source.AGENT_EVENT_STREAM_SAFETY_TICK_MS, 5000),
    AGENT_EVENT_STREAM_HEARTBEAT_MS: parsePositiveInt(source.AGENT_EVENT_STREAM_HEARTBEAT_MS, 15000),
    PHOENIX_ENABLED: source.PHOENIX_ENABLED === 'true',
    PHOENIX_COLLECTOR_ENDPOINT: source.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006/v1/traces',
    PHOENIX_PROJECT_NAME: source.PHOENIX_PROJECT_NAME ?? 'trading-lab',
    PHOENIX_READ_BASE_URL: derivePhoenixReadBaseUrl(source),
    PHOENIX_API_KEY: source.PHOENIX_API_KEY,
    RESEARCH_TASK_TOKEN_BUDGET: parseNonNegativeInt(source.RESEARCH_TASK_TOKEN_BUDGET, 200000),
    STRATEGY_PREFLIGHT_CRITIQUE: source.STRATEGY_PREFLIGHT_CRITIQUE !== 'false',
    STRATEGY_CRITIC_ADAPTER: resolveAdapter(source.STRATEGY_CRITIC_ADAPTER),
    STRATEGY_CRITIC_MODE: source.STRATEGY_CRITIC_MODE === 'two_stage' ? 'two_stage' : 'single',
    STRATEGY_CRITIC_MODEL: strategyCriticModel,
    STRATEGY_REFINER_MODEL: source.STRATEGY_REFINER_MODEL || strategyCriticModel,
    WFO_GATE1_ADAPTER: resolveAdapter(source.WFO_GATE1_ADAPTER),
    WFO_GATE1_MODEL: source.WFO_GATE1_MODEL ?? 'anthropic/claude-sonnet-4-6',
    WFO_SWEEP_DESIGNER_ADAPTER: resolveAdapter(source.WFO_SWEEP_DESIGNER_ADAPTER),
    WFO_SWEEP_DESIGNER_MODEL: source.WFO_SWEEP_DESIGNER_MODEL ?? 'anthropic/claude-sonnet-4-6',
    WFO_RESULT_INTERPRETER_ADAPTER: resolveAdapter(source.WFO_RESULT_INTERPRETER_ADAPTER),
    WFO_RESULT_INTERPRETER_MODEL: source.WFO_RESULT_INTERPRETER_MODEL ?? 'anthropic/claude-sonnet-4-6',
    PAPER_WINDOW_MIN_TRADES: parsePositiveInt(source.PAPER_WINDOW_MIN_TRADES, 30),
    PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD: parsePositiveInt(source.PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD, 15),
    PAPER_WINDOW_MIN_DAYS: parsePositiveInt(source.PAPER_WINDOW_MIN_DAYS, 3),
    PAPER_WINDOW_MAX_DAYS: parsePositiveInt(source.PAPER_WINDOW_MAX_DAYS, 30),
    PAPER_MONITOR_MAX_WAIT_DAYS: parsePositiveInt(source.PAPER_MONITOR_MAX_WAIT_DAYS, 7),
    PAPER_MONITOR_POLL_MS: parsePositiveInt(source.PAPER_MONITOR_POLL_MS, 21600000),
    REVISION_BATCH_MAX: parsePositiveInt(source.REVISION_BATCH_MAX, 5),
    LAB_PAPER_EVIDENCE_REQUIRED: source.LAB_PAPER_EVIDENCE_REQUIRED === 'true',
    LAB_TRUSTED_SIGNERS_JSON: parseTrustedSigners(source.LAB_TRUSTED_SIGNERS_JSON),
    ...loadRagEnv(source),
  };
}

function loadRagEnv(source: NodeJS.ProcessEnv): Pick<
  Env,
  | 'OPERATOR_RAG_ENABLED'
  | 'OPERATOR_EMBEDDING_PROVIDER'
  | 'OPERATOR_EMBEDDING_MODEL'
  | 'OPERATOR_EMBEDDING_DIMENSIONS'
  | 'OPERATOR_RETRIEVAL_INDEX_VERSION'
  | 'OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS'
  | 'OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS'
  | 'OPERATOR_RETRIEVAL_LEXICAL_LIMIT'
  | 'OPERATOR_RETRIEVAL_VECTOR_LIMIT'
  | 'OPERATOR_RETRIEVAL_FUSED_LIMIT'
  | 'OPERATOR_RERANKER'
  | 'OPERATOR_RERANK_TIMEOUT_MS'
  | 'OPERATOR_RERANK_LIMIT'
  | 'OPERATOR_RERANK_MIN_CANDIDATES'
  | 'OPERATOR_RERANK_RRF_MARGIN'
> {
  const dims = parsePositiveInt(source.OPERATOR_EMBEDDING_DIMENSIONS, 1024);
  if (dims !== 1024) {
    throw new Error(
      `OPERATOR_EMBEDDING_DIMENSIONS must be 1024 (got ${dims}). Only 1024-dimensional embeddings are supported.`,
    );
  }

  const softMs = parsePositiveInt(source.OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS, 5000);
  const hardMs = parsePositiveInt(source.OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS, 10000);
  if (hardMs < softMs) {
    throw new Error(
      `OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS (${hardMs}) must be >= OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS (${softMs}).`,
    );
  }

  return {
    OPERATOR_RAG_ENABLED: source.OPERATOR_RAG_ENABLED === 'true',
    OPERATOR_EMBEDDING_PROVIDER: 'openrouter',
    OPERATOR_EMBEDDING_MODEL: source.OPERATOR_EMBEDDING_MODEL ?? 'baai/bge-m3',
    OPERATOR_EMBEDDING_DIMENSIONS: 1024,
    OPERATOR_RETRIEVAL_INDEX_VERSION: parsePositiveInt(source.OPERATOR_RETRIEVAL_INDEX_VERSION, 1),
    OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS: softMs,
    OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS: hardMs,
    OPERATOR_RETRIEVAL_LEXICAL_LIMIT: parsePositiveInt(source.OPERATOR_RETRIEVAL_LEXICAL_LIMIT, 50),
    OPERATOR_RETRIEVAL_VECTOR_LIMIT: parsePositiveInt(source.OPERATOR_RETRIEVAL_VECTOR_LIMIT, 50),
    OPERATOR_RETRIEVAL_FUSED_LIMIT: parsePositiveInt(source.OPERATOR_RETRIEVAL_FUSED_LIMIT, 20),
    OPERATOR_RERANKER: source.OPERATOR_RERANKER === 'mastra' ? 'mastra' : 'none',
    OPERATOR_RERANK_TIMEOUT_MS: parsePositiveInt(source.OPERATOR_RERANK_TIMEOUT_MS, 1500),
    OPERATOR_RERANK_LIMIT: parsePositiveInt(source.OPERATOR_RERANK_LIMIT, 5),
    OPERATOR_RERANK_MIN_CANDIDATES: parsePositiveInt(source.OPERATOR_RERANK_MIN_CANDIDATES, 10),
    OPERATOR_RERANK_RRF_MARGIN: parseFloatOr(source.OPERATOR_RERANK_RRF_MARGIN, 0.002),
  };
}
