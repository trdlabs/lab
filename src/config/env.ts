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
  TRADING_PLATFORM_INTEGRATION: 'mock' | 'mcp' | 'backtester';
  BACKTESTER_API_URL?: string;
  BACKTESTER_API_TOKEN?: string;
  BACKTEST_BACKEND: 'research_platform';
  PLATFORM_RUN_MAX_POLLS: number;
  PLATFORM_RUN_POLL_DELAY_MS: number;
  TRADING_PLATFORM_BASELINE_VERSION: string;
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

function parseFloatOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const agentsDefault: 'fake' | 'mastra' = source.LAB_AGENTS_ADAPTER === 'mastra' ? 'mastra' : 'fake';
  const resolveAdapter = (v: string | undefined): 'fake' | 'mastra' =>
    v === 'mastra' ? 'mastra' : v === 'fake' ? 'fake' : agentsDefault;

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
      source.TRADING_PLATFORM_INTEGRATION === 'mcp'
        ? 'mcp'
        : source.TRADING_PLATFORM_INTEGRATION === 'backtester'
          ? 'backtester'
          : 'mock',
    BACKTESTER_API_URL: source.BACKTESTER_API_URL,
    BACKTESTER_API_TOKEN: source.BACKTESTER_API_TOKEN,
    BACKTEST_BACKEND: 'research_platform',
    PLATFORM_RUN_MAX_POLLS: parsePositiveInt(source.PLATFORM_RUN_MAX_POLLS, 30),
    PLATFORM_RUN_POLL_DELAY_MS: parsePositiveInt(source.PLATFORM_RUN_POLL_DELAY_MS, 2000),
    TRADING_PLATFORM_BASELINE_VERSION: source.TRADING_PLATFORM_BASELINE_VERSION ?? 'v1',
    STRATEGY_ANALYST_ADAPTER: resolveAdapter(source.STRATEGY_ANALYST_ADAPTER),
    STRATEGY_ANALYST_MODEL: source.STRATEGY_ANALYST_MODEL ?? 'anthropic/claude-sonnet-4-6',
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
