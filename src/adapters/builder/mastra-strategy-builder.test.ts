import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraStrategyBuilder, BuilderError } from './mastra-strategy-builder.ts';
import type { StrategyBuilderInput } from '../../ports/strategy-builder.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid StrategyLlmOutput — satisfies StrategyLlmOutputSchema.strict() */
const validObject = {
  manifest: {
    id: 'strat-001',
    version: '1.0.0',
    kind: 'strategy',
    name: 'Test Strategy',
    summary: 'A test strategy',
    rationale: 'Testing purposes',
    hooks: ['onBarClose'],
    paramsSchema: '{}',
    capabilities: JSON.stringify({
      exchangeDirect: null, brokerDirect: null, filesystem: null, network: null,
      process: null, env: null, dynamicEval: null, platformSdk: null,
    }),
    dataNeeds: JSON.stringify({
      closedCandlesUpToCurrent: null, asOfIndicators: null, openInterest: null,
      liquidations: null, funding: null, taker: null, forwardBars: null,
      forwardWindow: null, oracle: null, labeling: null, postTradeOutcome: null,
      wallClock: null, uncontrolledRandom: null,
    }),
    author: null,
    status: null,
    params: null,
    source: null,
    targetStrategyRef: null,
    interceptionPoint: null,
  },
  source: 'export default function createStrategyModule() { return {}; }',
  notes: null,
};

/** Object that will fail StrategyLlmOutputSchema.parse (missing required fields) */
const invalidObject = { notAStrategy: true };

/** Object with smuggled bundleHash — strict parse must reject */
const objectWithBundleHash = {
  ...validObject,
  bundleHash: 'sha256:abc',
};

function makeProfile(): StrategyProfile {
  return {
    id: 'p1',
    version: 1,
    sourceKind: 'bot_code',
    sourceFingerprint: 'fp1',
    direction: 'long',
    coreIdea: 'A momentum strategy',
    requiredMarketFeatures: ['oi'],
    confidence: 0.8,
    unknowns: [],
    profile: {
      direction: 'long',
      coreIdea: 'A momentum strategy',
      summary: 'Enters long when OI increases',
      requiredMarketFeatures: ['oi'],
      entryConditions: ['OI increases for 2 bars'],
      exitConditions: ['OI decreases'],
      timeframes: ['5m'],
      indicators: [],
      parameters: [],
      watchLifecycleSummary: null,
      positionManagementSummary: null,
      riskManagementSummary: null,
      runnerOwnedAuthorities: ['position sizing'],
      confidence: 0.8,
      unknowns: [],
      evidence: [],
    },
    sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const baseInput: StrategyBuilderInput = {
  spec: { id: 'spec-1', name: 'Test', description: 'Test spec' },
  authoringDoc: 'Build a strategy',
  profile: makeProfile(),
};

// ---------------------------------------------------------------------------
// fakeAgent helpers
// ---------------------------------------------------------------------------

function fakeAgent(object: unknown): Agent {
  return { generate: async () => ({ object, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }) } as unknown as Agent;
}

function countingAgent(objects: unknown[]): { agent: Agent; callCount: () => number } {
  let count = 0;
  const agent = {
    generate: async () => {
      const obj = objects[count] ?? objects[objects.length - 1];
      count++;
      return { object: obj, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  } as unknown as Agent;
  return { agent, callCount: () => count };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastraStrategyBuilder', () => {
  describe('happy path', () => {
    it('returns valid StrategyBuilderOutput when agent returns valid object', async () => {
      const builder = new MastraStrategyBuilder(fakeAgent(validObject), 'test-model');
      const result = await builder.build(baseInput);
      expect(result.source).toBe('export default function createStrategyModule() { return {}; }');
      expect(result.manifestMeta.id).toBe('strat-001');
      expect(result.manifestMeta.name).toBe('Test Strategy');
    });

    it('calls agent.generate with structuredOutput: { schema: StrategyLlmOutputSchema }', async () => {
      const generateSpy = vi.fn().mockResolvedValue({ object: validObject, usage: {} });
      const agent = { generate: generateSpy } as unknown as Agent;
      const builder = new MastraStrategyBuilder(agent, 'test-model');
      await builder.build(baseInput);
      expect(generateSpy).toHaveBeenCalledOnce();
      const [, callOpts] = generateSpy.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(callOpts).toHaveProperty('structuredOutput');
      expect(callOpts.structuredOutput).toHaveProperty('schema');
    });

    it('reports usage via onUsage callback', async () => {
      const usageEvents: unknown[] = [];
      const builder = new MastraStrategyBuilder(fakeAgent(validObject), 'my-model');
      await builder.build(baseInput, { onUsage: (u) => { usageEvents.push(u); } });
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({ modelId: 'my-model', inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    });

    it('exposes adapter="mastra" and model from label', () => {
      const builder = new MastraStrategyBuilder(fakeAgent(validObject), 'claude-opus');
      expect(builder.adapter).toBe('mastra');
      expect(builder.model).toBe('claude-opus');
    });
  });

  describe('L1 exhaustion', () => {
    it('retries exactly maxAttempts times then throws BuilderError', async () => {
      const { agent, callCount } = countingAgent([invalidObject]);
      const builder = new MastraStrategyBuilder(agent, 'test-model', { maxAttempts: 3 });
      await expect(builder.build(baseInput)).rejects.toThrow(BuilderError);
      expect(callCount()).toBe(3);
    });

    it('respects custom maxAttempts=1', async () => {
      const { agent, callCount } = countingAgent([invalidObject]);
      const builder = new MastraStrategyBuilder(agent, 'test-model', { maxAttempts: 1 });
      await expect(builder.build(baseInput)).rejects.toThrow(BuilderError);
      expect(callCount()).toBe(1);
    });

    it('error message mentions attempt count', async () => {
      const { agent } = countingAgent([invalidObject]);
      const builder = new MastraStrategyBuilder(agent, 'test-model', { maxAttempts: 2 });
      await expect(builder.build(baseInput)).rejects.toThrow(/2/);
    });
  });

  describe('L1 recovery', () => {
    it('succeeds on last attempt when first (maxAttempts-1) fail', async () => {
      // 3 attempts: invalid, invalid, valid
      const { agent, callCount } = countingAgent([invalidObject, invalidObject, validObject]);
      const builder = new MastraStrategyBuilder(agent, 'test-model', { maxAttempts: 3 });
      const result = await builder.build(baseInput);
      expect(result.source).toBe('export default function createStrategyModule() { return {}; }');
      expect(callCount()).toBe(3);
    });

    it('succeeds on second attempt when first fails (maxAttempts=2)', async () => {
      const { agent, callCount } = countingAgent([invalidObject, validObject]);
      const builder = new MastraStrategyBuilder(agent, 'test-model', { maxAttempts: 2 });
      const result = await builder.build(baseInput);
      expect(result.source).toContain('createStrategyModule');
      expect(callCount()).toBe(2);
    });
  });

  describe('strict reject (smuggled fields)', () => {
    it('rejects object with extra bundleHash field via strict parse', async () => {
      // .strict() on StrategyLlmOutputSchema rejects extra keys
      const { agent } = countingAgent([objectWithBundleHash]);
      const builder = new MastraStrategyBuilder(agent, 'test-model', { maxAttempts: 2 });
      await expect(builder.build(baseInput)).rejects.toThrow(BuilderError);
    });
  });

  describe('feedback forwarding', () => {
    it('includes feedback in the message passed to agent.generate', async () => {
      const generateSpy = vi.fn().mockResolvedValue({ object: validObject, usage: {} });
      const agent = { generate: generateSpy } as unknown as Agent;
      const builder = new MastraStrategyBuilder(agent, 'test-model');
      const feedbackInput: StrategyBuilderInput = {
        ...baseInput,
        feedback: { kind: 'validation', violations: ['missing exit condition', 'invalid hook'] },
      };
      await builder.build(feedbackInput);
      const [userMsg] = generateSpy.mock.calls[0] as [string, ...unknown[]];
      expect(userMsg).toContain('missing exit condition');
      expect(userMsg).toContain('invalid hook');
      expect(userMsg).toContain('FEEDBACK');
    });

    it('omits feedback section when no feedback provided', async () => {
      const generateSpy = vi.fn().mockResolvedValue({ object: validObject, usage: {} });
      const agent = { generate: generateSpy } as unknown as Agent;
      const builder = new MastraStrategyBuilder(agent, 'test-model');
      await builder.build(baseInput);
      const [userMsg] = generateSpy.mock.calls[0] as [string, ...unknown[]];
      expect(userMsg).not.toContain('FEEDBACK');
    });
  });
});
