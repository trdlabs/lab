import { DEFAULT_EVALUATOR_THRESHOLDS, type EvaluatorThresholds } from '../validation/evaluator.ts';
import { MODEL_PROVIDERS, type ModelProvider } from '../adapters/llm/model-provider.ts';

export interface Env {
  DATABASE_URL?: string;
  REDIS_URL?: string;
  ARTIFACT_DIR: string;
  ENABLE_CRITIC_AGENT: boolean;
  INGRESS_PORT: number;
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
  INTENT_CLASSIFIER_ADAPTER: 'fake' | 'mastra';
  INTENT_CLASSIFIER_MODEL: string;
  INTENT_CLASSIFIER_MIN_CONFIDENCE: number;
  CHAT_MAX_MESSAGE_CHARS: number;
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
  return {
    DATABASE_URL: source.DATABASE_URL,
    REDIS_URL: source.REDIS_URL,
    ARTIFACT_DIR: source.ARTIFACT_DIR ?? '.artifacts',
    ENABLE_CRITIC_AGENT: source.ENABLE_CRITIC_AGENT === 'true',
    INGRESS_PORT: parsePort(source.INGRESS_PORT, 3000),
    STRATEGY_ANALYST_ADAPTER: source.STRATEGY_ANALYST_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    STRATEGY_ANALYST_MODEL: source.STRATEGY_ANALYST_MODEL ?? 'anthropic/claude-sonnet-4-6',
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
    RUN_LLM_TESTS: source.RUN_LLM_TESTS === 'true',
    RESEARCHER_ADAPTER: source.RESEARCHER_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    RESEARCHER_MODEL: source.RESEARCHER_MODEL ?? 'anthropic/claude-sonnet-4-6',
    CRITIC_ADAPTER: source.CRITIC_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    CRITIC_MODEL: source.CRITIC_MODEL ?? 'anthropic/claude-sonnet-4-6',
    MAX_HYPOTHESES_PER_CYCLE: parsePositiveInt(source.MAX_HYPOTHESES_PER_CYCLE, 5),
    BUILDER_ADAPTER: source.BUILDER_ADAPTER === 'mastra' ? 'mastra' : 'fake',
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
    INTENT_CLASSIFIER_ADAPTER: source.INTENT_CLASSIFIER_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    INTENT_CLASSIFIER_MODEL: source.INTENT_CLASSIFIER_MODEL ?? 'anthropic/claude-haiku-4-5-20251001',
    INTENT_CLASSIFIER_MIN_CONFIDENCE: parseFloatOr(source.INTENT_CLASSIFIER_MIN_CONFIDENCE, 0.6),
    CHAT_MAX_MESSAGE_CHARS: parsePositiveInt(source.CHAT_MAX_MESSAGE_CHARS, 4000),
  };
}
