import { describe, expect, it } from 'vitest';
import type { BuilderPort, BuilderInput, BuilderOutput } from '../../ports/builder.port.ts';
import { runBuilderEval } from './eval-harness.ts';
import { defaultBuilderEvalInput } from './fixtures.ts';

function validOutput(input: BuilderInput): BuilderOutput {
  const hyp = input.hypothesis;
  return {
    manifest: {
      moduleId: `overlay-${hyp.id}`,
      moduleKind: 'hypothesis_overlay',
      appliesTo: hyp.ruleAction.appliesTo,
      entry: 'index.ts',
      exports: ['overlay'],
      capabilities: hyp.requiredFeatures,
      sdkContractVersion: 'builder-sdk-v0',
    },
    files: {
      'index.ts': `export const overlay = { appliesTo: '${hyp.ruleAction.appliesTo}', rules: [{ when: '${hyp.ruleAction.rules[0]!.when}', action: '${hyp.ruleAction.rules[0]!.action}', params: {} }] };`,
    },
  };
}

function stubBuilder(overrideFn?: (input: BuilderInput) => BuilderOutput): BuilderPort {
  return {
    adapter: 'stub',
    model: 'stub',
    async build(input) {
      return overrideFn ? overrideFn(input) : validOutput(input);
    },
  };
}

const deps = {
  builderFor: () => stubBuilder(),
  providerOf: (m: string) => ({ provider: 'stub', modelId: m }),
  clock: () => Date.now(),
};

describe('runBuilderEval', () => {
  it('runs each hypothesis for each model × repeat and aggregates results', async () => {
    const input = defaultBuilderEvalInput(['model-a', 'model-b'], 0.7, 2);
    const result = await runBuilderEval(input, deps);

    // 2 models × 2 hypotheses × 2 repeats = 8 total
    expect(result.perModel).toHaveLength(8);
    expect(result.aggregates).toHaveLength(2);
    expect(result.aggregates.every((a) => a.passRate === 1)).toBe(true);
  });

  it('reports PASS for valid overlay output', async () => {
    const input = defaultBuilderEvalInput(['model-a'], 0.7, 1);
    const result = await runBuilderEval(input, deps);
    expect(result.overallSuccess).toBe(true);
    expect(result.aggregates[0]!.passRate).toBe(1);
  });

  it('reports FAIL when builder throws an error', async () => {
    const errorDeps = {
      ...deps,
      builderFor: () => ({
        adapter: 'stub', model: 'stub',
        async build(): Promise<BuilderOutput> { throw new Error('provider error'); },
      } satisfies BuilderPort),
    };
    const input = defaultBuilderEvalInput(['model-a'], 0.7, 1);
    const result = await runBuilderEval(input, errorDeps);
    expect(result.aggregates[0]!.passRate).toBe(0);
    expect(result.perModel.every((r) => r.error?.type === 'provider')).toBe(true);
  });

  it('feeds hypothesis sequentially — each CandidateResult has a hypothesisId', async () => {
    const input = defaultBuilderEvalInput(['model-a'], 0.7, 1);
    const seenHypothesisIds: string[] = [];
    const trackingDeps = {
      ...deps,
      builderFor: () => ({
        adapter: 'stub', model: 'stub',
        async build(inp: BuilderInput): Promise<BuilderOutput> {
          seenHypothesisIds.push(inp.hypothesis.id);
          return validOutput(inp);
        },
      } satisfies BuilderPort),
    };
    await runBuilderEval(input, trackingDeps);

    expect(seenHypothesisIds).toHaveLength(input.hypotheses.length);
    expect(new Set(seenHypothesisIds).size).toBe(input.hypotheses.length);
  });

  it('aggregates scoreMean across hypotheses for a model', async () => {
    const input = defaultBuilderEvalInput(['model-a'], 0.7, 1);
    const result = await runBuilderEval(input, deps);
    const agg = result.aggregates[0]!;
    expect(agg.scoreMean).not.toBeNull();
    expect(agg.scoreMean!).toBeGreaterThan(0);
  });
});
