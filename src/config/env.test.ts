import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../validation/evaluator.ts';

describe('loadEnv SP-3 fields', () => {
  it('defaults researcher and critic to fake and bounds hypotheses', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('fake');
    expect(env.CRITIC_ADAPTER).toBe('fake');
    expect(env.MAX_HYPOTHESES_PER_CYCLE).toBe(5);
  });

  it('honors overrides and rejects non-positive guardrails', () => {
    const env = loadEnv({ RESEARCHER_ADAPTER: 'mastra', MAX_HYPOTHESES_PER_CYCLE: '0' } as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('mastra');
    expect(env.MAX_HYPOTHESES_PER_CYCLE).toBe(5); // 0 is invalid -> fallback
  });
});

describe('SP-4 env', () => {
  it('defaults builder + thresholds', () => {
    const env = loadEnv({});
    expect(env.BUILDER_ADAPTER).toBe('fake');
    expect(env.BUILDER_MODEL).toBe('anthropic/claude-sonnet-4-6');
    expect(env.evaluatorThresholds).toEqual(DEFAULT_EVALUATOR_THRESHOLDS);
  });

  it('reads builder + threshold overrides', () => {
    const env = loadEnv({ BUILDER_ADAPTER: 'mastra', EVAL_MIN_TRADES: '40', EVAL_STRONG_PNL_DELTA_USD: '500', EVAL_MIN_PROFIT_FACTOR: '1.8' });
    expect(env.BUILDER_ADAPTER).toBe('mastra');
    expect(env.evaluatorThresholds.minTrades).toBe(40);
    expect(env.evaluatorThresholds.strongPnlDeltaUsd).toBe(500);
    expect(env.evaluatorThresholds.minProfitFactor).toBe(1.8);
  });
});

describe('SP-4.5 model provider env', () => {
  it('defaults MODEL_PROVIDER to anthropic, keys undefined', () => {
    const env = loadEnv({});
    expect(env.MODEL_PROVIDER).toBe('anthropic');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('reads MODEL_PROVIDER + provider keys', () => {
    const env = loadEnv({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-o', OPENROUTER_API_KEY: 'sk-or' });
    expect(env.MODEL_PROVIDER).toBe('openai');
    expect(env.OPENAI_API_KEY).toBe('sk-o');
    expect(env.OPENROUTER_API_KEY).toBe('sk-or');
  });

  it('falls back to anthropic for an unknown MODEL_PROVIDER value', () => {
    expect(loadEnv({ MODEL_PROVIDER: 'bogus' }).MODEL_PROVIDER).toBe('anthropic');
  });
});

describe('loadEnv read API config', () => {
  it('defaults READ_API_PORT to 3100 and token to undefined', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.READ_API_PORT).toBe(3100);
    expect(env.TRADING_LAB_READ_TOKEN).toBeUndefined();
  });

  it('reads READ_API_PORT and TRADING_LAB_READ_TOKEN from source', () => {
    const env = loadEnv({ READ_API_PORT: '4601', TRADING_LAB_READ_TOKEN: 'secret' } as unknown as NodeJS.ProcessEnv);
    expect(env.READ_API_PORT).toBe(4601);
    expect(env.TRADING_LAB_READ_TOKEN).toBe('secret');
  });
});

describe('SP-6 agent-activity knobs', () => {
  it('defaults the four knobs', () => {
    const env = loadEnv({});
    expect(env.AGENT_ACTIVITY_REBUILD_WINDOW_HOURS).toBe(24);
    expect(env.AGENT_ACTIVITY_TRACE_LIMIT).toBe(50);
    expect(env.AGENT_EVENT_STREAM_SAFETY_TICK_MS).toBe(5000);
    expect(env.AGENT_EVENT_STREAM_HEARTBEAT_MS).toBe(15000);
  });
  it('parses overrides', () => {
    const env = loadEnv({
      AGENT_ACTIVITY_REBUILD_WINDOW_HOURS: '6',
      AGENT_ACTIVITY_TRACE_LIMIT: '10',
      AGENT_EVENT_STREAM_SAFETY_TICK_MS: '1000',
      AGENT_EVENT_STREAM_HEARTBEAT_MS: '30000',
    });
    expect(env.AGENT_ACTIVITY_REBUILD_WINDOW_HOURS).toBe(6);
    expect(env.AGENT_ACTIVITY_TRACE_LIMIT).toBe(10);
    expect(env.AGENT_EVENT_STREAM_SAFETY_TICK_MS).toBe(1000);
    expect(env.AGENT_EVENT_STREAM_HEARTBEAT_MS).toBe(30000);
  });
});

describe('SP-6.1 chat ingress token', () => {
  it('defaults TRADING_LAB_CHAT_TOKEN to undefined', () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).TRADING_LAB_CHAT_TOKEN).toBeUndefined();
  });

  it('reads TRADING_LAB_CHAT_TOKEN from source', () => {
    const env = loadEnv({ TRADING_LAB_CHAT_TOKEN: 'chat-secret' } as unknown as NodeJS.ProcessEnv);
    expect(env.TRADING_LAB_CHAT_TOKEN).toBe('chat-secret');
  });
});

describe('SP-6.2 task + callback ingress tokens', () => {
  it('defaults both tokens to undefined', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.TRADING_LAB_TASK_TOKEN).toBeUndefined();
    expect(env.TRADING_LAB_CALLBACK_TOKEN).toBeUndefined();
  });

  it('reads TRADING_LAB_TASK_TOKEN and TRADING_LAB_CALLBACK_TOKEN from source', () => {
    const env = loadEnv({
      TRADING_LAB_TASK_TOKEN: 'task-secret',
      TRADING_LAB_CALLBACK_TOKEN: 'callback-secret',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.TRADING_LAB_TASK_TOKEN).toBe('task-secret');
    expect(env.TRADING_LAB_CALLBACK_TOKEN).toBe('callback-secret');
  });
});

describe('loadEnv — SP-7.2b backtest backend', () => {
  it('defaults backtest backend + poll + baseline version', () => {
    const e = loadEnv({ DATABASE_URL: 'x', REDIS_URL: 'y' } as NodeJS.ProcessEnv);
    expect(e.BACKTEST_BACKEND).toBe('research_platform');
    expect(e.PLATFORM_RUN_MAX_POLLS).toBe(30);
    expect(e.PLATFORM_RUN_POLL_DELAY_MS).toBe(2000);
    expect(e.TRADING_PLATFORM_BASELINE_VERSION).toBe('v1');
  });

  it('reads research_platform + overrides', () => {
    const e = loadEnv({
      BACKTEST_BACKEND: 'research_platform', PLATFORM_RUN_MAX_POLLS: '5',
      PLATFORM_RUN_POLL_DELAY_MS: '100', TRADING_PLATFORM_BASELINE_VERSION: 'v3',
    } as NodeJS.ProcessEnv);
    expect(e.BACKTEST_BACKEND).toBe('research_platform');
    expect(e.PLATFORM_RUN_MAX_POLLS).toBe(5);
    expect(e.PLATFORM_RUN_POLL_DELAY_MS).toBe(100);
    expect(e.TRADING_PLATFORM_BASELINE_VERSION).toBe('v3');
  });

  it('falls back to research_platform for an unknown backend value', () => {
    const e = loadEnv({ BACKTEST_BACKEND: 'bogus' } as NodeJS.ProcessEnv);
    expect(e.BACKTEST_BACKEND).toBe('research_platform');
  });
});

describe('RAG retrieval config', () => {
  it('defaults all RAG fields correctly', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.OPERATOR_RAG_ENABLED).toBe(false);
    expect(env.OPERATOR_EMBEDDING_PROVIDER).toBe('openrouter');
    expect(env.OPERATOR_EMBEDDING_MODEL).toBe('baai/bge-m3');
    expect(env.OPERATOR_EMBEDDING_DIMENSIONS).toBe(1024);
    expect(env.OPERATOR_RETRIEVAL_INDEX_VERSION).toBe(1);
    expect(env.OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS).toBe(5000);
    expect(env.OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS).toBe(10000);
    expect(env.OPERATOR_RETRIEVAL_LEXICAL_LIMIT).toBe(50);
    expect(env.OPERATOR_RETRIEVAL_VECTOR_LIMIT).toBe(50);
    expect(env.OPERATOR_RETRIEVAL_FUSED_LIMIT).toBe(20);
  });

  it('reads overrides for RAG fields', () => {
    const env = loadEnv({
      OPERATOR_RAG_ENABLED: 'true',
      OPERATOR_EMBEDDING_MODEL: 'openai/text-embedding-3-small',
      OPERATOR_RETRIEVAL_INDEX_VERSION: '2',
      OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS: '3000',
      OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS: '8000',
      OPERATOR_RETRIEVAL_LEXICAL_LIMIT: '100',
      OPERATOR_RETRIEVAL_VECTOR_LIMIT: '75',
      OPERATOR_RETRIEVAL_FUSED_LIMIT: '30',
    } as NodeJS.ProcessEnv);
    expect(env.OPERATOR_RAG_ENABLED).toBe(true);
    expect(env.OPERATOR_EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
    expect(env.OPERATOR_RETRIEVAL_INDEX_VERSION).toBe(2);
    expect(env.OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS).toBe(3000);
    expect(env.OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS).toBe(8000);
    expect(env.OPERATOR_RETRIEVAL_LEXICAL_LIMIT).toBe(100);
    expect(env.OPERATOR_RETRIEVAL_VECTOR_LIMIT).toBe(75);
    expect(env.OPERATOR_RETRIEVAL_FUSED_LIMIT).toBe(30);
  });

  it('throws when OPERATOR_EMBEDDING_DIMENSIONS is not 1024', () => {
    expect(() =>
      loadEnv({ OPERATOR_EMBEDDING_DIMENSIONS: '768' } as NodeJS.ProcessEnv),
    ).toThrow(/1024/);
  });

  it('throws when OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS < OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS', () => {
    expect(() =>
      loadEnv({
        OPERATOR_RETRIEVAL_SOFT_TIMEOUT_MS: '8000',
        OPERATOR_RETRIEVAL_HARD_TIMEOUT_MS: '4000',
      } as NodeJS.ProcessEnv),
    ).toThrow(/timeout/i);
  });
});

describe('reranker env', () => {
  const base = { DATABASE_URL: 'x', REDIS_URL: 'y' } as NodeJS.ProcessEnv;
  it('defaults reranker off with §7 defaults', () => {
    const env = loadEnv(base);
    expect(env.OPERATOR_RERANKER).toBe('none');
    expect(env.OPERATOR_RERANK_TIMEOUT_MS).toBe(1500);
    expect(env.OPERATOR_RERANK_LIMIT).toBe(5);
    expect(env.OPERATOR_RERANK_MIN_CANDIDATES).toBe(10);
    expect(env.OPERATOR_RERANK_RRF_MARGIN).toBe(0.002);
  });
  it('parses mastra + overrides', () => {
    const env = loadEnv({ ...base, OPERATOR_RERANKER: 'mastra', OPERATOR_RERANK_TIMEOUT_MS: '800' });
    expect(env.OPERATOR_RERANKER).toBe('mastra');
    expect(env.OPERATOR_RERANK_TIMEOUT_MS).toBe(800);
  });
});

describe('Phoenix observability env', () => {
  it('defaults Phoenix off with localhost collector + trading-lab project', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.PHOENIX_ENABLED).toBe(false);
    expect(env.PHOENIX_COLLECTOR_ENDPOINT).toBe('http://localhost:6006/v1/traces');
    expect(env.PHOENIX_PROJECT_NAME).toBe('trading-lab');
  });

  it('reads Phoenix overrides from source', () => {
    const env = loadEnv({
      PHOENIX_ENABLED: 'true',
      PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix:6006/v1/traces',
      PHOENIX_PROJECT_NAME: 'trading-lab-vps',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.PHOENIX_ENABLED).toBe(true);
    expect(env.PHOENIX_COLLECTOR_ENDPOINT).toBe('http://phoenix:6006/v1/traces');
    expect(env.PHOENIX_PROJECT_NAME).toBe('trading-lab-vps');
  });

  it('treats any non-"true" PHOENIX_ENABLED as false', () => {
    expect(loadEnv({ PHOENIX_ENABLED: '1' } as unknown as NodeJS.ProcessEnv).PHOENIX_ENABLED).toBe(false);
    expect(loadEnv({ PHOENIX_ENABLED: 'yes' } as unknown as NodeJS.ProcessEnv).PHOENIX_ENABLED).toBe(false);
  });
});

describe('loadEnv — agent adapter family default', () => {
  const ADAPTERS = [
    'STRATEGY_ANALYST_ADAPTER',
    'RESEARCHER_ADAPTER',
    'CRITIC_ADAPTER',
    'BUILDER_ADAPTER',
    'TURN_INTERPRETER_ADAPTER',
  ] as const;

  it('defaults every agent adapter to fake when nothing is set', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    for (const k of ADAPTERS) expect(env[k]).toBe('fake');
  });

  it('LAB_AGENTS_ADAPTER=mastra flips all five to mastra', () => {
    const env = loadEnv({ LAB_AGENTS_ADAPTER: 'mastra' } as NodeJS.ProcessEnv);
    for (const k of ADAPTERS) expect(env[k]).toBe('mastra');
  });

  it('a per-agent value overrides the mastra family default', () => {
    const env = loadEnv({ LAB_AGENTS_ADAPTER: 'mastra', BUILDER_ADAPTER: 'fake' } as NodeJS.ProcessEnv);
    expect(env.BUILDER_ADAPTER).toBe('fake');
    expect(env.STRATEGY_ANALYST_ADAPTER).toBe('mastra');
    expect(env.RESEARCHER_ADAPTER).toBe('mastra');
    expect(env.CRITIC_ADAPTER).toBe('mastra');
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('mastra');
  });

  it('a per-agent mastra still works when the family default is fake', () => {
    const env = loadEnv({ STRATEGY_ANALYST_ADAPTER: 'mastra' } as NodeJS.ProcessEnv);
    expect(env.STRATEGY_ANALYST_ADAPTER).toBe('mastra');
    expect(env.RESEARCHER_ADAPTER).toBe('fake');
    expect(env.CRITIC_ADAPTER).toBe('fake');
    expect(env.BUILDER_ADAPTER).toBe('fake');
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('fake');
  });

  it('an invalid LAB_AGENTS_ADAPTER falls back to fake', () => {
    const env = loadEnv({ LAB_AGENTS_ADAPTER: 'bogus' } as NodeJS.ProcessEnv);
    for (const k of ADAPTERS) expect(env[k]).toBe('fake');
  });
});
