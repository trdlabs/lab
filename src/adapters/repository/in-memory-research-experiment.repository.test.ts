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
});
