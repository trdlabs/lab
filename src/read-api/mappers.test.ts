import { describe, it, expect } from 'vitest';
import { toHypothesisListItem, toHypothesisDetail, toBacktestDto, toAgentEventDto, toExperimentRunMemberDto } from './mappers.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';

const HYP_LIST_KEYS = ['id', 'profileId', 'thesis', 'targetBehavior', 'status', 'confidence', 'expectedEffect', 'rulesSummary', 'createdAt', 'updatedAt'];
const BACKTEST_KEYS = ['id', 'hypothesisId', 'status', 'metrics', 'delta', 'isFragile', 'submittedAt', 'finishedAt', 'createdAt', 'updatedAt'];

function hyp(over: Partial<HypothesisProposal> = {}): HypothesisProposal {
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'thesis', targetBehavior: 'tb',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x>1', action: 'skip_entry', params: { threshold: 5 }, rationale: 'r' }] },
    requiredFeatures: ['oi'], validationPlan: 'plan', expectedEffect: { metric: 'pnl', direction: 'increase' },
    invalidationCriteria: ['c'], confidence: 0.7, status: 'validated', fingerprint: 'SECRET-FP',
    proposal: { thesis: 'draft' } as HypothesisProposal['proposal'], issues: [], contractVersion: 'v1',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...over,
  };
}
function backtest(over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id: 'r1', hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1', platformRunId: 'PLAT-SECRET',
    correlationId: 'CORR-SECRET', params: { foo: 'bar' }, paramsHash: 'HASH', bundleHash: 'BHASH', status: 'completed',
    baselineModuleId: 'MOD0', variantModuleId: 'MOD1',
    backend: 'sp4_mock', resumeToken: null, platformRun: null,
    metrics: { netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.6, profitFactor: 2, maxDrawdownPct: 8, expectancyUsd: 8, sharpe: 1.4, topTradeContributionPct: 22 },
    baselineMetrics: null, deltaNetPnlUsd: 150, deltaMaxDrawdownPct: 1, isFragile: false,
    artifactRefs: ['platform://x'], platformContractVersion: 'PCV', sdkContractVersion: 'SCV',
    submittedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...over,
  };
}

describe('hypothesis mappers', () => {
  it('list item: exact allowlist key set + summary-only rules', () => {
    const dto = toHypothesisListItem(hyp());
    expect(Object.keys(dto).sort()).toEqual([...HYP_LIST_KEYS].sort());
    expect(dto.rulesSummary).toEqual({ appliesTo: 'long', ruleCount: 1 });
    expect(JSON.stringify(dto)).not.toContain('SECRET-FP');
    expect(JSON.stringify(dto)).not.toContain('threshold');
  });

  it('detail: curated rules drop params; never leak fingerprint/proposal/issues/contractVersion', () => {
    const dto = toHypothesisDetail(hyp());
    expect(dto.rules.rules).toEqual([{ when: 'x>1', action: 'skip_entry', rationale: 'r' }]);
    const json = JSON.stringify(dto);
    for (const leak of ['SECRET-FP', 'threshold', 'contractVersion', 'draft']) expect(json).not.toContain(leak);
    expect((dto as unknown as Record<string, unknown>).fingerprint).toBeUndefined();
  });

  it('detail: rejectionReasons only when rejected', () => {
    expect(toHypothesisDetail(hyp({ status: 'validated' })).rejectionReasons).toBeUndefined();
    const rejected = toHypothesisDetail(hyp({ status: 'rejected', issues: [{ code: 'x', severity: 'error', path: 'a', message: 'too risky' }] }));
    expect(rejected.rejectionReasons).toEqual(['too risky']);
  });
});

describe('backtest mapper', () => {
  it('exact allowlist key set; never leak platform/params/hashes/modules/contracts/artifacts', () => {
    const dto = toBacktestDto(backtest());
    expect(Object.keys(dto).sort()).toEqual([...BACKTEST_KEYS].sort());
    const json = JSON.stringify(dto);
    for (const leak of ['PLAT-SECRET', 'CORR-SECRET', 'HASH', 'BHASH', 'MOD0', 'MOD1', 'PCV', 'SCV', 'platform://x', 'foo']) {
      expect(json).not.toContain(leak);
    }
    expect(dto.metrics.netPnlUsd).toBe(250);
    expect(dto.delta).toEqual({ netPnlUsd: 150, maxDrawdownPct: 1 });
  });

  it('null metrics when not completed', () => {
    const dto = toBacktestDto(backtest({ metrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null }));
    expect(dto.metrics.netPnlUsd).toBeNull();
    expect(dto.delta.netPnlUsd).toBeNull();
  });
});

describe('agent-event mapper (deny-by-default)', () => {
  it('known type: only allowlisted scalar payload keys survive', () => {
    const row: AgentEventRow = { id: 'e1', taskId: 't1', type: 'strategy_analyst.completed', payload: { profileId: 'p1', secret: 'KEY', nested: { a: 1 } }, createdAt: '2026-01-01T00:00:00.000Z', correlationId: 'c1' };
    const dto = toAgentEventDto(row);
    expect(dto.payloadSummary).toEqual({ profileId: 'p1' });
    const json = JSON.stringify(dto);
    expect(json).not.toContain('KEY');
    expect(json).not.toContain('nested');
    expect(dto.level).toBe('info');
    expect(dto.correlationId).toBe('c1');
  });

  it('strategy.onboard.deduped: payloadSummary exposes profileId; fingerprint never leaks', () => {
    const row: AgentEventRow = { id: 'e3', taskId: 't1', type: 'strategy.onboard.deduped', payload: { profileId: 'p-dedup', fingerprint: 'SECRET-FP' }, createdAt: '2026-01-01T00:00:00.000Z' };
    const dto = toAgentEventDto(row);
    expect(dto.payloadSummary).toEqual({ profileId: 'p-dedup' });
    expect(JSON.stringify(dto)).not.toContain('SECRET-FP');
  });

  it('unknown type: empty payloadSummary + summary derived from type; raw payload never leaks', () => {
    const row: AgentEventRow = { id: 'e2', taskId: 't1', type: 'some.unknown.event', payload: { token: 'SECRET' }, createdAt: '2026-01-01T00:00:00.000Z' };
    const dto = toAgentEventDto(row);
    expect(dto.payloadSummary).toBeUndefined();
    expect(dto.summary).toBe('Some Unknown Event');
    expect(JSON.stringify(dto)).not.toContain('SECRET');
  });

  it('derives error level from type', () => {
    expect(toAgentEventDto({ id: 'e', taskId: 't', type: 'strategy_analyst.failed', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' }).level).toBe('error');
  });
});

describe('experiment run member mapper', () => {
  it('maps strategyBacktestRunId null-preserving', () => {
    const dto = toExperimentRunMemberDto({
      id: 'm1', experimentId: 'e1', role: 'sanity', periodFrom: 'a', periodTo: 'b',
      symbols: ['S'], paramsHash: '', bundleHash: 'h', createdAt: 't',
      strategyBacktestRunId: 'sbr_1',
    } as any);
    expect(dto.strategyBacktestRunId).toBe('sbr_1');
    expect(dto.backtestRunId ?? null).toBeNull();
  });
});
