// src/orchestrator/handlers/author-strategy-bundle.handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  authorStrategyBundleHandler,
  type AuthorStrategyInput,
} from './author-strategy-bundle.handler.ts';
import { FakeStrategyBuilder } from '../../adapters/builder/fake-strategy-builder.ts';
import { FixtureBacktesterAdapter } from '../../adapters/platform/fixture-backtester.adapter.ts';
import { InMemoryArtifactStore } from '../../adapters/artifact/in-memory-artifact-store.ts';
import type {
  BacktesterStrategyPort,
  StrategyRunResult,
  StrategyRunSubmission,
} from '../../ports/backtester-strategy.port.ts';
import type { StrategyBuilderOutput } from '../../ports/strategy-builder.port.ts';

const BASE_INPUT: AuthorStrategyInput = {
  spec: { id: 'test', name: 'Test Strategy' },
  authoringDoc: 'Build a test strategy.',
};

/** Builder that returns an ambient-authority source (process.env) to trigger validate-rejected. */
const AMBIENT_SOURCE = `export default function createStrategyModule(){ const x = process.env.X; return { onBarClose(){ return { kind: 'idle' }; } }; }`;

const ambientBuilder = {
  async build(_i: unknown): Promise<StrategyBuilderOutput> {
    return {
      source: AMBIENT_SOURCE,
      manifestMeta: {
        id: 'ambient_test',
        version: '0.1.0',
        name: 'Ambient Test',
        summary: 'test',
        rationale: 'test',
        paramsSchema: {
          type: 'object' as const,
          additionalProperties: false,
          required: [],
          properties: {},
        },
        params: {},
        capabilities: { platformSdk: true },
        dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true },
        hooks: ['onBarClose'] as ['onBarClose'],
      },
    };
  },
};

describe('authorStrategyBundleHandler', () => {
  it('happy path (signed): returns signed status with bundleRef and evidenceRef persisted', async () => {
    const artifacts = new InMemoryArtifactStore();
    const result = await authorStrategyBundleHandler(BASE_INPUT, {
      strategyBuilder: new FakeStrategyBuilder(),
      artifacts,
      backtesterStrategy: new FixtureBacktesterAdapter({ outcome: 'signed' }),
    });

    expect(result.status).toBe('signed');
    expect(result.bundleHash).toBeDefined();
    expect(result.bundleRef).toBeDefined();
    expect(result.evidenceRef).toBeDefined();

    // strategy_bundle artifact is present and readable
    const bundleBuf = await artifacts.get(result.bundleRef!);
    const bundleObj = JSON.parse(bundleBuf.toString('utf8'));
    expect(bundleObj).toHaveProperty('bundleHash');
    expect(bundleObj).toHaveProperty('source');
    expect(bundleObj).toHaveProperty('manifest');

    // backtest_evidence artifact is present and readable
    const evidenceBuf = await artifacts.get(result.evidenceRef!);
    const evidenceObj = JSON.parse(evidenceBuf.toString('utf8'));
    expect(evidenceObj.body.schema).toBe('backtest-evidence/v1');
  });

  describe('backtester outcomes (parametrized)', () => {
    const nonSignedOutcomes: Array<StrategyRunResult['status']> = [
      'equivalent',
      'divergent',
      'rejected',
      'unavailable',
    ];

    for (const outcome of nonSignedOutcomes) {
      it(`outcome=${outcome}: bundleRef defined, evidenceRef undefined`, async () => {
        const artifacts = new InMemoryArtifactStore();
        const result = await authorStrategyBundleHandler(BASE_INPUT, {
          strategyBuilder: new FakeStrategyBuilder(),
          artifacts,
          backtesterStrategy: new FixtureBacktesterAdapter({ outcome }),
        });

        expect(result.status).toBe(outcome);
        expect(result.bundleRef).toBeDefined(); // persist-before-submit: bundle always stored
        expect(result.evidenceRef).toBeUndefined(); // evidence only on signed
      });
    }

    it('divergent outcome includes divergence field', async () => {
      const result = await authorStrategyBundleHandler(BASE_INPUT, {
        strategyBuilder: new FakeStrategyBuilder(),
        artifacts: new InMemoryArtifactStore(),
        backtesterStrategy: new FixtureBacktesterAdapter({ outcome: 'divergent' }),
      });

      expect(result.status).toBe('divergent');
      expect(result.divergence).toBeDefined();
    });
  });

  it('idempotent retry: same input twice → same bundleRef (content-addressed dedup)', async () => {
    const artifacts = new InMemoryArtifactStore();
    const deps = {
      strategyBuilder: new FakeStrategyBuilder(),
      artifacts,
      backtesterStrategy: new FixtureBacktesterAdapter({ outcome: 'signed' }),
    };

    const r1 = await authorStrategyBundleHandler(BASE_INPUT, deps);
    const r2 = await authorStrategyBundleHandler(BASE_INPUT, deps);

    expect(r1.bundleRef).toBeDefined();
    expect(r1.bundleRef!.artifact_id).toBe(r2.bundleRef!.artifact_id);
  });

  it('validate-rejected: returns rejected, does NOT persist bundle, does NOT call backtester', async () => {
    const artifacts = new InMemoryArtifactStore();
    const submitSpy = vi.fn<
      (s: StrategyRunSubmission) => Promise<StrategyRunResult>
    >();
    const spyBacktester: BacktesterStrategyPort = {
      submitStrategyRun: submitSpy,
    };

    const result = await authorStrategyBundleHandler(BASE_INPUT, {
      strategyBuilder: ambientBuilder,
      artifacts,
      backtesterStrategy: spyBacktester,
    });

    expect(result.status).toBe('rejected');
    expect(result.bundleRef).toBeUndefined(); // fail-closed: untrusted code never stored
    expect(result.violations).toBeDefined();
    expect(result.violations!.length).toBeGreaterThan(0);
    expect(submitSpy).not.toHaveBeenCalled(); // backtester never reached
  });
});
