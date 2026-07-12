import { describe, it, expect } from 'vitest';
import { loadEnv, parseTrustedSigners } from './env.ts';
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

  it('defaults STRATEGY_ANALYST_MODEL to gpt-5.5 (analyst:eval verdict) and honors override', () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).STRATEGY_ANALYST_MODEL).toBe('openrouter/openai/gpt-5.5');
    expect(
      loadEnv({ STRATEGY_ANALYST_MODEL: 'openrouter/x-ai/grok-4.3' } as NodeJS.ProcessEnv).STRATEGY_ANALYST_MODEL,
    ).toBe('openrouter/x-ai/grok-4.3');
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
    expect(e.RESEARCH_GRID_CONCURRENCY).toBe(4);
    expect(e.LAB_QUEUE_CONCURRENCY).toBe(1);
  });

  it('reads research_platform + overrides', () => {
    const e = loadEnv({
      BACKTEST_BACKEND: 'research_platform', PLATFORM_RUN_MAX_POLLS: '5',
      PLATFORM_RUN_POLL_DELAY_MS: '100', TRADING_PLATFORM_BASELINE_VERSION: 'v3',
      RESEARCH_GRID_CONCURRENCY: '2', LAB_QUEUE_CONCURRENCY: '3',
    } as NodeJS.ProcessEnv);
    expect(e.BACKTEST_BACKEND).toBe('research_platform');
    expect(e.PLATFORM_RUN_MAX_POLLS).toBe(5);
    expect(e.PLATFORM_RUN_POLL_DELAY_MS).toBe(100);
    expect(e.TRADING_PLATFORM_BASELINE_VERSION).toBe('v3');
    expect(e.RESEARCH_GRID_CONCURRENCY).toBe(2);
    expect(e.LAB_QUEUE_CONCURRENCY).toBe(3);
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

  it('[P1-17] an invalid LAB_AGENTS_ADAPTER is rejected (fail-closed, no silent fake)', () => {
    expect(() => loadEnv({ LAB_AGENTS_ADAPTER: 'bogus' } as NodeJS.ProcessEnv)).toThrow(/LAB_AGENTS_ADAPTER/);
  });
});

describe('research task token budget env', () => {
  it('defaults RESEARCH_TASK_TOKEN_BUDGET to 200000', () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(200000);
  });
  it('reads an override and allows 0 (unlimited)', () => {
    expect(loadEnv({ RESEARCH_TASK_TOKEN_BUDGET: '50000' } as unknown as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(50000);
    expect(loadEnv({ RESEARCH_TASK_TOKEN_BUDGET: '0' } as unknown as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(0);
  });
  it('falls back to default on an invalid value', () => {
    expect(loadEnv({ RESEARCH_TASK_TOKEN_BUDGET: 'abc' } as unknown as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(200000);
    expect(loadEnv({ RESEARCH_TASK_TOKEN_BUDGET: '-3' } as unknown as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(200000);
  });
});

describe('pre-flight strategy critic env', () => {
  it('defaults the critic ON with fake adapter + single mode + grok-4.3 model', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.STRATEGY_PREFLIGHT_CRITIQUE).toBe(true);
    expect(env.STRATEGY_CRITIC_ADAPTER).toBe('fake');
    expect(env.STRATEGY_CRITIC_MODE).toBe('single');
    expect(env.STRATEGY_CRITIC_MODEL).toBe('openrouter/x-ai/grok-4.3');
    expect(env.STRATEGY_REFINER_MODEL).toBe('openrouter/x-ai/grok-4.3'); // defaults to critic model
  });

  it('STRATEGY_PREFLIGHT_CRITIQUE=false disables it; any other value keeps it on', () => {
    expect(loadEnv({ STRATEGY_PREFLIGHT_CRITIQUE: 'false' } as unknown as NodeJS.ProcessEnv).STRATEGY_PREFLIGHT_CRITIQUE).toBe(false);
    expect(loadEnv({ STRATEGY_PREFLIGHT_CRITIQUE: '1' } as unknown as NodeJS.ProcessEnv).STRATEGY_PREFLIGHT_CRITIQUE).toBe(true);
  });

  it('STRATEGY_CRITIC_MODE=two_stage selects two_stage; any other value falls back to single', () => {
    expect(loadEnv({ STRATEGY_CRITIC_MODE: 'two_stage' } as unknown as NodeJS.ProcessEnv).STRATEGY_CRITIC_MODE).toBe('two_stage');
    expect(loadEnv({ STRATEGY_CRITIC_MODE: 'bogus' } as unknown as NodeJS.ProcessEnv).STRATEGY_CRITIC_MODE).toBe('single');
  });

  it('reads overrides; refiner model defaults to the critic model when unset', () => {
    const env = loadEnv({
      STRATEGY_CRITIC_ADAPTER: 'mastra',
      STRATEGY_CRITIC_MODEL: 'anthropic/claude-sonnet-4-6',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.STRATEGY_CRITIC_ADAPTER).toBe('mastra');
    expect(env.STRATEGY_CRITIC_MODEL).toBe('anthropic/claude-sonnet-4-6');
    expect(env.STRATEGY_REFINER_MODEL).toBe('anthropic/claude-sonnet-4-6');
  });

  it('[P1-17] rejects a non-fake/mastra STRATEGY_CRITIC_ADAPTER and honors an explicit refiner model', () => {
    expect(() => loadEnv({ STRATEGY_CRITIC_ADAPTER: 'bogus' } as unknown as NodeJS.ProcessEnv)).toThrow(/STRATEGY_CRITIC_ADAPTER/);
    const env = loadEnv({ STRATEGY_REFINER_MODEL: 'openrouter/google/gemini-3.5-flash' } as unknown as NodeJS.ProcessEnv);
    expect(env.STRATEGY_REFINER_MODEL).toBe('openrouter/google/gemini-3.5-flash');
  });

  it('collapses to critic model when STRATEGY_REFINER_MODEL is empty string (docker passthrough pattern)', () => {
    const env = loadEnv({ STRATEGY_REFINER_MODEL: '' } as unknown as NodeJS.ProcessEnv);
    expect(env.STRATEGY_REFINER_MODEL).toBe('openrouter/x-ai/grok-4.3');
  });

  it('STRATEGY_CRITIC_ADAPTER inherits the LAB_AGENTS_ADAPTER family; an explicit value overrides it', () => {
    // keyless → fake (family default, LAB_AGENTS_ADAPTER unset)
    expect(loadEnv({} as NodeJS.ProcessEnv).STRATEGY_CRITIC_ADAPTER).toBe('fake');
    // NEW: inherits the family when LAB_AGENTS_ADAPTER=mastra — exactly like analyst/researcher/etc.
    expect(
      loadEnv({ LAB_AGENTS_ADAPTER: 'mastra' } as unknown as NodeJS.ProcessEnv).STRATEGY_CRITIC_ADAPTER,
    ).toBe('mastra');
    // per-agent override wins: explicit STRATEGY_CRITIC_ADAPTER=fake beats LAB_AGENTS_ADAPTER=mastra
    expect(
      loadEnv({
        LAB_AGENTS_ADAPTER: 'mastra',
        STRATEGY_CRITIC_ADAPTER: 'fake',
      } as unknown as NodeJS.ProcessEnv).STRATEGY_CRITIC_ADAPTER,
    ).toBe('fake');
  });
});

describe('loadEnv — Phoenix read config', () => {
  it('derives PHOENIX_READ_BASE_URL from the collector endpoint by default', () => {
    const env = loadEnv({ PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix:6006/v1/traces' } as NodeJS.ProcessEnv);
    expect(env.PHOENIX_READ_BASE_URL).toBe('http://phoenix:6006');
  });

  it('honors an explicit PHOENIX_READ_BASE_URL and PHOENIX_API_KEY', () => {
    const env = loadEnv({ PHOENIX_READ_BASE_URL: 'http://px:6006/', PHOENIX_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(env.PHOENIX_READ_BASE_URL).toBe('http://px:6006');
    expect(env.PHOENIX_API_KEY).toBe('k');
  });

  it('defaults the read base url to localhost when nothing is set', () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).PHOENIX_READ_BASE_URL).toBe('http://localhost:6006');
  });
});

describe('loadEnv — paper window policy', () => {
  it('defaults to minTrades=30, lowConfidenceThreshold=15, minDays=3, maxDays=30, maxWaitDays=7', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.PAPER_WINDOW_MIN_TRADES).toBe(30);
    expect(env.PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD).toBe(15);
    expect(env.PAPER_WINDOW_MIN_DAYS).toBe(3);
    expect(env.PAPER_WINDOW_MAX_DAYS).toBe(30);
    expect(env.PAPER_MONITOR_MAX_WAIT_DAYS).toBe(7);
  });

  it('honors overrides', () => {
    const env = loadEnv({
      PAPER_WINDOW_MIN_TRADES: '50',
      PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD: '20',
      PAPER_WINDOW_MIN_DAYS: '5',
      PAPER_WINDOW_MAX_DAYS: '45',
      PAPER_MONITOR_MAX_WAIT_DAYS: '10',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.PAPER_WINDOW_MIN_TRADES).toBe(50);
    expect(env.PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD).toBe(20);
    expect(env.PAPER_WINDOW_MIN_DAYS).toBe(5);
    expect(env.PAPER_WINDOW_MAX_DAYS).toBe(45);
    expect(env.PAPER_MONITOR_MAX_WAIT_DAYS).toBe(10);
  });

  it('falls back to defaults on non-positive-int values', () => {
    const env = loadEnv({
      PAPER_WINDOW_MIN_TRADES: '0',
      PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD: 'abc',
      PAPER_WINDOW_MIN_DAYS: '-1',
      PAPER_WINDOW_MAX_DAYS: '3.5',
      PAPER_MONITOR_MAX_WAIT_DAYS: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.PAPER_WINDOW_MIN_TRADES).toBe(30);
    expect(env.PAPER_WINDOW_LOW_CONFIDENCE_THRESHOLD).toBe(15);
    expect(env.PAPER_WINDOW_MIN_DAYS).toBe(3);
    expect(env.PAPER_WINDOW_MAX_DAYS).toBe(30);
    expect(env.PAPER_MONITOR_MAX_WAIT_DAYS).toBe(7);
  });
});

describe('parseTrustedSigners (Task 4)', () => {
  it('returns {} on undefined', () => {
    expect(parseTrustedSigners(undefined)).toEqual({});
  });

  it('returns {} on an empty string', () => {
    expect(parseTrustedSigners('')).toEqual({});
  });

  it('round-trips a valid keyId -> PEM map', () => {
    const map = { 'signer-1': '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----' };
    expect(parseTrustedSigners(JSON.stringify(map))).toEqual(map);
  });

  it('throws /LAB_TRUSTED_SIGNERS_JSON/ on malformed JSON', () => {
    expect(() => parseTrustedSigners('{not json')).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
  });

  it('throws /LAB_TRUSTED_SIGNERS_JSON/ when a value is not a string', () => {
    expect(() => parseTrustedSigners(JSON.stringify({ k: 123 }))).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
  });

  it('throws /LAB_TRUSTED_SIGNERS_JSON/ when the JSON is not a flat object', () => {
    expect(() => parseTrustedSigners('[]')).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
    expect(() => parseTrustedSigners('null')).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
    expect(() => parseTrustedSigners('"just a string"')).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
    expect(() => parseTrustedSigners('42')).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
  });

  it('throws /LAB_TRUSTED_SIGNERS_JSON/ when a signer value is null', () => {
    expect(() => parseTrustedSigners('{"bt-ed25519-abc": null}')).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
  });

  it('throws /LAB_TRUSTED_SIGNERS_JSON/ when a signer value is a nested object', () => {
    expect(() => parseTrustedSigners('{"bt-ed25519-abc": {"nested":"x"}}')).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
  });
});

describe('LAB_PAPER_EVIDENCE_REQUIRED + LAB_TRUSTED_SIGNERS_JSON via loadEnv (Task 4)', () => {
  it('defaults LAB_PAPER_EVIDENCE_REQUIRED to false and LAB_TRUSTED_SIGNERS_JSON to {}', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.LAB_PAPER_EVIDENCE_REQUIRED).toBe(false);
    expect(env.LAB_TRUSTED_SIGNERS_JSON).toEqual({});
  });

  it('LAB_PAPER_EVIDENCE_REQUIRED=true enables it; any other value keeps it false', () => {
    expect(loadEnv({ LAB_PAPER_EVIDENCE_REQUIRED: 'true' } as unknown as NodeJS.ProcessEnv).LAB_PAPER_EVIDENCE_REQUIRED).toBe(true);
    expect(loadEnv({ LAB_PAPER_EVIDENCE_REQUIRED: '1' } as unknown as NodeJS.ProcessEnv).LAB_PAPER_EVIDENCE_REQUIRED).toBe(false);
  });

  it('reads LAB_TRUSTED_SIGNERS_JSON through loadEnv', () => {
    const map = { 'signer-1': 'pem-1' };
    const env = loadEnv({ LAB_TRUSTED_SIGNERS_JSON: JSON.stringify(map) } as unknown as NodeJS.ProcessEnv);
    expect(env.LAB_TRUSTED_SIGNERS_JSON).toEqual(map);
  });

  it('propagates the parseTrustedSigners throw through loadEnv on malformed JSON', () => {
    expect(() =>
      loadEnv({ LAB_TRUSTED_SIGNERS_JSON: '{bad' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/LAB_TRUSTED_SIGNERS_JSON/);
  });
});

describe('CONSOLIDATOR_ADAPTER + CONSOLIDATOR_MODEL (slice G3b, Task 5)', () => {
  it('defaults CONSOLIDATOR_ADAPTER to off (NOT routed through resolveAdapter/LAB_AGENTS_ADAPTER)', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.CONSOLIDATOR_ADAPTER).toBe('off');
    expect(env.CONSOLIDATOR_MODEL).toBe('openrouter/anthropic/claude-opus-4-8');
  });

  it('stays off even when LAB_AGENTS_ADAPTER=mastra (consolidation is opt-in only)', () => {
    const env = loadEnv({ LAB_AGENTS_ADAPTER: 'mastra' } as unknown as NodeJS.ProcessEnv);
    expect(env.CONSOLIDATOR_ADAPTER).toBe('off');
  });

  it('passes through CONSOLIDATOR_ADAPTER=mastra and =fake explicitly', () => {
    expect(loadEnv({ CONSOLIDATOR_ADAPTER: 'mastra' } as unknown as NodeJS.ProcessEnv).CONSOLIDATOR_ADAPTER).toBe('mastra');
    expect(loadEnv({ CONSOLIDATOR_ADAPTER: 'fake' } as unknown as NodeJS.ProcessEnv).CONSOLIDATOR_ADAPTER).toBe('fake');
  });

  it('honors a CONSOLIDATOR_MODEL override', () => {
    expect(
      loadEnv({ CONSOLIDATOR_MODEL: 'anthropic/claude-sonnet-4-6' } as unknown as NodeJS.ProcessEnv).CONSOLIDATOR_MODEL,
    ).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('LAB_CONSOLIDATION_DEPTH_THRESHOLD (slice G3b, Task 7)', () => {
  it('defaults to 2', () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).LAB_CONSOLIDATION_DEPTH_THRESHOLD).toBe(2);
  });

  it('reads an override', () => {
    expect(loadEnv({ LAB_CONSOLIDATION_DEPTH_THRESHOLD: '3' } as unknown as NodeJS.ProcessEnv).LAB_CONSOLIDATION_DEPTH_THRESHOLD).toBe(3);
  });

  it('honors 0 as a kill-switch (NOT coerced to the default)', () => {
    expect(loadEnv({ LAB_CONSOLIDATION_DEPTH_THRESHOLD: '0' } as unknown as NodeJS.ProcessEnv).LAB_CONSOLIDATION_DEPTH_THRESHOLD).toBe(0);
  });

  it('falls back to the default on an invalid value', () => {
    expect(loadEnv({ LAB_CONSOLIDATION_DEPTH_THRESHOLD: 'abc' } as unknown as NodeJS.ProcessEnv).LAB_CONSOLIDATION_DEPTH_THRESHOLD).toBe(2);
    expect(loadEnv({ LAB_CONSOLIDATION_DEPTH_THRESHOLD: '-3' } as unknown as NodeJS.ProcessEnv).LAB_CONSOLIDATION_DEPTH_THRESHOLD).toBe(2);
  });
});

describe('trade-preservation gate env (Task 4)', () => {
  it('loads preservation thresholds with defaults and gate on', () => {
    const env = loadEnv({});
    expect(env.preservationGateEnabled).toBe(true);
    expect(env.preservationThresholds.winnerRetention).toBe(0.9);
    expect(env.preservationThresholds.minWinnerSample).toBe(3);
  });

  it('honors LAB_TRADE_PRESERVATION_GATE=off and env overrides', () => {
    const env = loadEnv({
      LAB_TRADE_PRESERVATION_GATE: 'off',
      LAB_TRADE_PRESERVATION_EOD_SHARE: '0.4',
    });
    expect(env.preservationGateEnabled).toBe(false);
    expect(env.preservationThresholds.eodShare).toBe(0.4);
  });
});

describe('LAB_CONSOLIDATION_TOL_REL / LAB_CONSOLIDATION_TOL_ABS (slice G3b, Task 8)', () => {
  it('defaults to 0.001 / 0.01', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.LAB_CONSOLIDATION_TOL_REL).toBe(0.001);
    expect(env.LAB_CONSOLIDATION_TOL_ABS).toBe(0.01);
  });

  it('reads overrides', () => {
    const env = loadEnv({ LAB_CONSOLIDATION_TOL_REL: '0.02', LAB_CONSOLIDATION_TOL_ABS: '0.5' } as unknown as NodeJS.ProcessEnv);
    expect(env.LAB_CONSOLIDATION_TOL_REL).toBe(0.02);
    expect(env.LAB_CONSOLIDATION_TOL_ABS).toBe(0.5);
  });

  it('falls back to the default on an invalid value', () => {
    const env = loadEnv({ LAB_CONSOLIDATION_TOL_REL: 'abc', LAB_CONSOLIDATION_TOL_ABS: 'xyz' } as unknown as NodeJS.ProcessEnv);
    expect(env.LAB_CONSOLIDATION_TOL_REL).toBe(0.001);
    expect(env.LAB_CONSOLIDATION_TOL_ABS).toBe(0.01);
  });
});

describe('queue-routing env knobs (Task 3)', () => {
  it('defaults LAB_REVISION_QUEUE_CONCURRENCY to 1 and LAB_PG_POOL_MAX to 10', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.LAB_REVISION_QUEUE_CONCURRENCY).toBe(1);
    expect(env.LAB_PG_POOL_MAX).toBe(10);
  });

  it('reads overrides for both knobs', () => {
    const env = loadEnv({
      LAB_REVISION_QUEUE_CONCURRENCY: '4',
      LAB_PG_POOL_MAX: '20',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.LAB_REVISION_QUEUE_CONCURRENCY).toBe(4);
    expect(env.LAB_PG_POOL_MAX).toBe(20);
  });

  it('falls back to defaults on invalid values (zero, negative, non-integer, non-numeric)', () => {
    const env = loadEnv({
      LAB_REVISION_QUEUE_CONCURRENCY: '0',
      LAB_PG_POOL_MAX: '-5',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.LAB_REVISION_QUEUE_CONCURRENCY).toBe(1);
    expect(env.LAB_PG_POOL_MAX).toBe(10);
  });

  it('falls back to defaults on non-numeric values', () => {
    const env = loadEnv({
      LAB_REVISION_QUEUE_CONCURRENCY: 'abc',
      LAB_PG_POOL_MAX: 'xyz',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.LAB_REVISION_QUEUE_CONCURRENCY).toBe(1);
    expect(env.LAB_PG_POOL_MAX).toBe(10);
  });

  it('falls back to defaults on empty string', () => {
    const env = loadEnv({
      LAB_REVISION_QUEUE_CONCURRENCY: '',
      LAB_PG_POOL_MAX: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.LAB_REVISION_QUEUE_CONCURRENCY).toBe(1);
    expect(env.LAB_PG_POOL_MAX).toBe(10);
  });
});

describe('[P1-17] fail-closed adapter/integration parsing', () => {
  it('throws on an unrecognized LAB_AGENTS_ADAPTER instead of silently falling back to fake', () => {
    expect(() => loadEnv({ LAB_AGENTS_ADAPTER: 'Mastra' } as NodeJS.ProcessEnv)).toThrow(/LAB_AGENTS_ADAPTER/);
  });

  it('throws on an unrecognized per-agent adapter (RESEARCHER_ADAPTER typo)', () => {
    expect(() => loadEnv({ RESEARCHER_ADAPTER: 'mastr' } as NodeJS.ProcessEnv)).toThrow(/RESEARCHER_ADAPTER/);
  });

  it('throws on an unrecognized TRADING_PLATFORM_INTEGRATION instead of silently falling back to mock', () => {
    expect(() => loadEnv({ TRADING_PLATFORM_INTEGRATION: 'backtestr' } as NodeJS.ProcessEnv)).toThrow(/TRADING_PLATFORM_INTEGRATION/);
  });

  it('treats an empty-string adapter/integration as unset → default (Docker passes `${VAR:-}` empties)', () => {
    const env = loadEnv({ STRATEGY_ANALYST_ADAPTER: '', RESEARCHER_ADAPTER: '', TRADING_PLATFORM_INTEGRATION: '' } as NodeJS.ProcessEnv);
    expect(env.STRATEGY_ANALYST_ADAPTER).toBe('fake');
    expect(env.RESEARCHER_ADAPTER).toBe('fake');
    expect(env.TRADING_PLATFORM_INTEGRATION).toBe('mock');
  });

  it('a per-agent adapter left empty inherits LAB_AGENTS_ADAPTER=mastra', () => {
    const env = loadEnv({ LAB_AGENTS_ADAPTER: 'mastra', RESEARCHER_ADAPTER: '' } as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('mastra');
  });
});
