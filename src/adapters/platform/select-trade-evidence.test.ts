import { describe, it, expect } from 'vitest';
import { selectTradeEvidence } from './select-trade-evidence.ts';
import { HttpTradeEvidenceAdapter } from './http-trade-evidence.adapter.ts';
import { MockTradeEvidenceAdapter } from './mock-trade-evidence.adapter.ts';
import { FixtureTradeEvidenceAdapter } from './fixture-trade-evidence.adapter.ts';

describe('selectTradeEvidence', () => {
  it('returns the HTTP adapter on the http integration path', () => {
    const port = selectTradeEvidence({ LAB_BOT_RESULTS_INTEGRATION: 'http', LAB_OPS_READ_URL: 'http://ops:8839', LAB_OPS_READ_TOKEN: 'tok' } as NodeJS.ProcessEnv);
    expect(port).toBeInstanceOf(HttpTradeEvidenceAdapter);
  });
  it('returns the Mock adapter by default (no env)', () => {
    expect(selectTradeEvidence({} as NodeJS.ProcessEnv)).toBeInstanceOf(MockTradeEvidenceAdapter);
  });
  it('returns the Fixture adapter on the fixture integration path', () => {
    const port = selectTradeEvidence({ LAB_BOT_RESULTS_INTEGRATION: 'fixture', LAB_OPS_READ_FIXTURE_DIR: '/tmp/x' } as NodeJS.ProcessEnv);
    expect(port).toBeInstanceOf(FixtureTradeEvidenceAdapter);
  });
});
