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
  };
}
