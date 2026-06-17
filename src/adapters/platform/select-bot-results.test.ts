import { describe, it, expect } from 'vitest';
import { selectBotResults, parseBotResultsIntegration } from './select-bot-results.ts';
import { MockBotResultsAdapter } from './mock-bot-results.adapter.ts';
import { FixtureBotResultsAdapter } from './fixture-bot-results.adapter.ts';
import { HttpOpsReadAdapter } from './http-ops-read.adapter.ts';

describe('parseBotResultsIntegration', () => {
  it('defaults to mock when unset/empty', () => {
    expect(parseBotResultsIntegration(undefined)).toBe('mock');
    expect(parseBotResultsIntegration('')).toBe('mock');
  });
  it('accepts the known values', () => {
    expect(parseBotResultsIntegration('mock')).toBe('mock');
    expect(parseBotResultsIntegration('http')).toBe('http');
    expect(parseBotResultsIntegration('fixture')).toBe('fixture');
  });
  it('throws (fail-closed) on an unknown value', () => {
    expect(() => parseBotResultsIntegration('live-prod')).toThrow(/LAB_BOT_RESULTS_INTEGRATION/);
  });
});

describe('selectBotResults', () => {
  it('returns the mock adapter by default', () => {
    expect(selectBotResults({} as NodeJS.ProcessEnv)).toBeInstanceOf(MockBotResultsAdapter);
  });
  it('returns the fixture adapter for fixture', () => {
    expect(selectBotResults({ LAB_BOT_RESULTS_INTEGRATION: 'fixture' } as unknown as NodeJS.ProcessEnv)).toBeInstanceOf(FixtureBotResultsAdapter);
  });
  it('returns the http adapter for http', () => {
    const env = { LAB_BOT_RESULTS_INTEGRATION: 'http', LAB_OPS_READ_URL: 'http://h:8839', LAB_OPS_READ_TOKEN: 't' } as unknown as NodeJS.ProcessEnv;
    expect(selectBotResults(env)).toBeInstanceOf(HttpOpsReadAdapter);
  });
});
