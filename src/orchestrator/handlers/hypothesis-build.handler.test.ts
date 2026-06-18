// src/orchestrator/handlers/hypothesis-build.handler.test.ts
import { describe, it, expect } from 'vitest';
import { hypothesisBuildHandler } from './hypothesis-build.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import type { PlatformGatewayPort } from '../../ports/platform-gateway.port.ts';
import { MockPlatformGatewayAdapter } from '../../adapters/platform/mock-platform-gateway.adapter.ts';
import { deriveOverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:s', direction: 'long',
    coreIdea: 'oi-based entry filter', requiredMarketFeatures: ['oi', 'funding'], confidence: 0.6, unknowns: [],
    profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now,
  };
}
function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when oi trend persists', targetBehavior: 'filter entries',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend persists for 2 bars', action: 'skip_entry', params: { bars: 2 } }] },
    requiredFeatures: ['oi', 'funding'], validationPlan: 'backtest 90d',
    expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['no improvement'],
    confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never,
    issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now,
  };
}
function task(payload: Record<string, unknown>): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload, createdAt: now, updatedAt: now };
}
async function seeded(over: Partial<AppServices> = {}): Promise<AppServices> {
  const s = makeServices(over);
  await s.strategyProfiles.create(profile());
  await s.hypotheses.create(hypothesis());
  return s;
}

describe('hypothesisBuildHandler', () => {
  it('happy path persists build(candidate→submitted), backtest_run(evaluated), evaluation + full event trail', async () => {
    const s = await seeded();
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);

    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('submitted');
    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs[0]?.status).toBe('evaluated');
    expect(runs[0]?.metrics?.netPnlUsd).toBe(250);
    const evals = await s.evaluations.listByBacktestRun(runs[0]!.id);
    expect(evals[0]?.decision).toBe('PAPER_CANDIDATE');

    const events = await s.events.listByTask('t1');
    const evTypes = events.map((e) => e.type);
    for (const t of ['build.started', 'builder.completed', 'build.validated', 'artifact.stored', 'backtest.submitted', 'backtest.completed', 'evaluation.completed']) {
      expect(evTypes).toContain(t);
    }
  });

  it('attaches overlayMeta (derived from hypothesis+profile) to the built bundle artifact', async () => {
    const s = await seeded();
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);
    const builds = await s.builds.listByHypothesis('h1');
    const ref = builds[0]!.bundleArtifactRef!;
    const stored = JSON.parse((await s.artifacts.get(ref)).toString('utf8')) as ModuleBundle;
    expect(stored.overlayMeta).toEqual(deriveOverlayManifestMeta(hypothesis(), profile(), stored.manifest));
  });

  it('same hypothesis + params + bundle does not re-submit (idempotent reuse)', async () => {
    let submitCount = 0;
    const base = new MockPlatformGatewayAdapter();
    const platform: PlatformGatewayPort = {
      getMarketContext: (sym, t) => base.getMarketContext(sym, t),
      getMarketRegime: (sym, t) => base.getMarketRegime(sym, t),
      submitBacktest: (req) => { submitCount += 1; return base.submitBacktest(req); },
      getBacktestResult: (ref) => base.getBacktestResult(ref),
    };
    const s = await seeded({ platform });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s); // identical inputs → reuse, no second submit
    expect(submitCount).toBe(1);
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(1);
    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toContain('backtest.reused');
  });

  it('throws when hypothesis is not validated', async () => {
    const s = makeServices();
    await s.strategyProfiles.create(profile());
    await s.hypotheses.create({ ...hypothesis(), status: 'rejected' });
    await expect(hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s)).rejects.toThrow(/not validated/);
  });

  it('Builder throws → build_failed (issue builder_failed), no artifact, no backtest_run, no submit', async () => {
    const throwingBuilder: BuilderPort = {
      adapter: 'fake', model: 'fake',
      build: async (_in: BuilderInput): Promise<BuilderOutput> => { throw new Error('builder boom'); },
    };
    const s = await seeded({ builder: throwingBuilder });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);

    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('build_failed');
    expect(builds[0]?.issues.map((i) => i.code)).toContain('builder_failed');
    expect(builds[0]?.bundleArtifactRef).toBeNull();
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(0);

    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toContain('build_failed');
    expect(evTypes).not.toContain('backtest.submitted');
  });

  it('passes non-empty sdkDoc to builder.build', async () => {
    let capturedSdkDoc: string | undefined;
    const spyBuilder: BuilderPort = {
      adapter: 'fake', model: 'spy',
      build: async (input: BuilderInput): Promise<BuilderOutput> => {
        capturedSdkDoc = input.sdkDoc;
        // Delegate to FakeBuilder to produce a valid output
        const { FakeBuilder } = await import('../../adapters/builder/fake-builder.ts');
        return new FakeBuilder().build(input);
      },
    };
    const s = await seeded({ builder: spyBuilder });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);
    expect(capturedSdkDoc).not.toBe('');
    expect((capturedSdkDoc ?? '').length).toBeGreaterThan(100);
  });

  it('Build Validator fails (denylist token in bundle) → build_failed with validator issues, no submit', async () => {
    const badBuilder: BuilderPort = {
      adapter: 'fake', model: 'fake',
      build: async (): Promise<BuilderOutput> => ({
        manifest: { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: 'builder-sdk-v0' },
        files: { 'index.ts': 'export const overlay = {}; const s = process.env.SECRET;' },
      }),
    };
    const s = await seeded({ builder: badBuilder });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);

    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('build_failed');
    expect(builds[0]?.issues.map((i) => i.code)).toContain('restricted_import');
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(0);
  });
});
