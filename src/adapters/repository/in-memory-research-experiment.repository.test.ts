import { describe, it, expect } from 'vitest';
import { InMemoryResearchExperimentRepository } from './in-memory-research-experiment.repository.ts';
import { DEFAULT_HOLDOUT_POLICY, type ResearchExperiment, type ExperimentRunMember } from '../../domain/research-experiment.ts';

function experiment(over: Partial<ResearchExperiment> = {}): ResearchExperiment {
  return {
    id: 'exp1', experimentKey: 'k1', experimentType: 'new_strategy_validation',
    strategyProfileId: 'p1', datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' } },
    holdoutPolicy: DEFAULT_HOLDOUT_POLICY, status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}
function member(over: Partial<ExperimentRunMember> = {}): ExperimentRunMember {
  return {
    id: 'm1', experimentId: 'exp1', role: 'sanity', periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: '2026-02-01T00:00:00.000Z', symbols: ['BTC'], paramsHash: 'ph', bundleHash: 'bh',
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

describe('InMemoryResearchExperimentRepository', () => {
  it('finds by id and key', async () => {
    const r = new InMemoryResearchExperimentRepository();
    await r.createExperiment(experiment());
    expect((await r.findById('exp1'))?.experimentKey).toBe('k1');
    expect((await r.findByKey('k1'))?.id).toBe('exp1');
    expect(await r.findByKey('nope')).toBeNull();
  });
  it('patches experiment and members, lists members in order', async () => {
    const r = new InMemoryResearchExperimentRepository();
    await r.createExperiment(experiment());
    await r.addMember(member({ id: 'm1', createdAt: '2026-01-01T00:00:01.000Z' }));
    await r.addMember(member({ id: 'm2', role: 'train', createdAt: '2026-01-01T00:00:02.000Z' }));
    await r.updateMember('m1', { backtestRunId: 'run1', tradeCount: 80 });
    await r.updateExperiment('exp1', { status: 'completed', verdict: 'PAPER_CANDIDATE' });
    const members = await r.listMembers('exp1');
    expect(members.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(members[0]?.tradeCount).toBe(80);
    expect((await r.findById('exp1'))?.verdict).toBe('PAPER_CANDIDATE');
  });
  it('round-trips parameterGrid on experiment and params/oos on member', async () => {
    const repo = new InMemoryResearchExperimentRepository();
    const exp = experiment({ id: 'exp2', experimentType: 'walk_forward_optimization', parameterGrid: { 'dump.minDropPct': [2, 5] } });
    await repo.createExperiment(exp);
    expect((await repo.findById(exp.id))?.parameterGrid).toEqual({ 'dump.minDropPct': [2, 5] });
    await repo.addMember(member({ id: 'm3', experimentId: exp.id, role: 'train', params: { 'dump.minDropPct': 2 }, oos: false, paramsHash: 'h1' }));
    await repo.addMember(member({ id: 'm4', experimentId: exp.id, role: 'holdout', params: { 'dump.minDropPct': 2 }, oos: true, paramsHash: 'h1' }));
    const members = await repo.listMembers(exp.id);
    expect(members.map((m) => m.oos)).toEqual([false, true]);
    expect(members[0]?.params).toEqual({ 'dump.minDropPct': 2 });
  });
  it('round-trips bundleArtifactRef through create/findById', async () => {
    const repo = new InMemoryResearchExperimentRepository();
    const ref = {
      artifact_id: 'art-1', uri: 'file:///tmp/a.json', content_hash: 'sha256:aa',
      kind: 'strategy_bundle', size_bytes: 10, mime_type: 'application/json',
      created_at: '2026-07-03T00:00:00.000Z', producer: 'test', metadata: {},
    };
    await repo.createExperiment(experiment({ id: 'exp-ref', experimentKey: 'k-ref', bundleArtifactRef: ref }));
    const got = await repo.findById('exp-ref');
    expect(got?.bundleArtifactRef).toEqual(ref);
  });
  it('round-trips bundleArtifactRef through updateExperiment (backfill path)', async () => {
    const repo = new InMemoryResearchExperimentRepository();
    const ref = {
      artifact_id: 'art-1', uri: 'file:///tmp/a.json', content_hash: 'sha256:aa',
      kind: 'strategy_bundle', size_bytes: 10, mime_type: 'application/json',
      created_at: '2026-07-03T00:00:00.000Z', producer: 'test', metadata: {},
    };
    await repo.createExperiment(experiment({ id: 'exp-backfill', experimentKey: 'k-backfill' }));
    expect((await repo.findById('exp-backfill'))?.bundleArtifactRef).toBeUndefined();

    await repo.updateExperiment('exp-backfill', { bundleArtifactRef: ref, updatedAt: '2026-01-02T00:00:00.000Z' });

    const got = await repo.findById('exp-backfill');
    expect(got?.bundleArtifactRef).toEqual(ref);
    expect(got?.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('listByType returns only that type, ordered createdAt ASC then id ASC', async () => {
    const repo = new InMemoryResearchExperimentRepository();
    // insert out of createdAt order to prove the ORDER BY, not insertion order
    await repo.createExperiment(experiment({ id: 'e2', experimentKey: 'k-e2', experimentType: 'strategy_baseline_validation', createdAt: '2026-02-01T00:00:00Z' }));
    await repo.createExperiment(experiment({ id: 'e1', experimentKey: 'k-e1', experimentType: 'strategy_baseline_validation', createdAt: '2026-01-01T00:00:00Z' }));
    await repo.createExperiment(experiment({ id: 'e3', experimentKey: 'k-e3', experimentType: 'walk_forward_optimization', createdAt: '2026-01-15T00:00:00Z' }));
    const rows = await repo.listByType('strategy_baseline_validation');
    expect(rows.map((r) => r.id)).toEqual(['e1', 'e2']); // createdAt ASC — NOT insertion order, no .sort()
    expect(rows.every((r) => r.experimentType === 'strategy_baseline_validation')).toBe(true);
  });
});
