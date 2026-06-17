import { describe, it, expect } from 'vitest';
import { MastraResearcher, buildPrompt } from './mastra-researcher.ts';
import { ResearcherOutputSchema } from '../../domain/hypothesis.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createResearcherAgent } from '../../mastra/agents/researcher.agent.ts';

const baseInput: ResearcherInput = {
  profile: { coreIdea: 'idea', direction: 'long', requiredMarketFeatures: [] } as unknown as StrategyProfile,
  marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: {} },
  marketRegime: 'ranging',
  similarHypotheses: [],
  maxHypotheses: 2,
};

const detail: BotRunResultDetail = {
  run: { runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] },
  summary: { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: 1, wins: 1, losses: 0, breakeven: 0, winratePct: 100, pnlUsd: '12.5', avgPnl: '12.5', exitReasons: { tp: 1 } },
  trades: [],
};

describe('buildPrompt bot-results block', () => {
  it('includes a bot-results block when botResults is non-empty', () => {
    const out = buildPrompt({ ...baseInput, botResults: [detail] });
    expect(out).toContain('Live/paper bot performance');
    expect(out).toContain('pnlUsd=12.5');
  });
  it('omits the block when botResults is empty or undefined', () => {
    expect(buildPrompt(baseInput)).not.toContain('Live/paper bot performance');
    expect(buildPrompt({ ...baseInput, botResults: [] })).not.toContain('Live/paper bot performance');
  });
});

const run = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;

describe('MastraResearcher (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const r = new MastraResearcher(createResearcherAgent(model), label);
    expect(r.adapter).toBe('mastra');
    expect(r.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

(run ? describe : describe.skip)('MastraResearcher (live)', () => {
  it('returns schema-valid output', async () => {
    const { model, label } = resolveLanguageModel(
      { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      'anthropic/claude-sonnet-4-6',
    );
    const profile: StrategyProfile = {
      id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:abc',
      direction: 'long', coreIdea: 'Buy capitulation wicks on high OI', requiredMarketFeatures: ['oi'],
      confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
      contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const input: ResearcherInput = {
      profile, marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: { oi: 1 } },
      marketRegime: 'capitulation', similarHypotheses: [], maxHypotheses: 2,
    };
    const out = await new MastraResearcher(createResearcherAgent(model), label).propose(input);
    expect(ResearcherOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
