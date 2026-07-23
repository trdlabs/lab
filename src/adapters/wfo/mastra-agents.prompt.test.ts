import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraGate1 } from './mastra-gate1.ts';
import { MastraSweepDesigner } from './mastra-sweep-designer.ts';
import { MastraResultInterpreter } from './mastra-result-interpreter.ts';
import type { Gate1Input, SweepInput, InterpretInput } from '../../ports/wfo-agents.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { RankedPoint } from '../../research/top-n-prefilter.ts';

const SENTINEL_NUM = 987654.321;
const SENTINEL_DATE = '2031-12-31T23:59:59.000Z';

function capturingAgent(object: unknown): { agent: Agent; prompts: string[] } {
  const prompts: string[] = [];
  const agent = {
    generate: async (prompt: string) => {
      prompts.push(prompt);
      return { object, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    },
  } as unknown as Agent;
  return { agent, prompts };
}

const profile = { coreIdea: 'dump-bounce long' } as unknown as StrategyProfile;

/** Closed metric block + runtime embargo extras, as an SDK/mapper widening would deliver them. */
const dirtyMetrics = {
  netPnlUsd: 100, maxDrawdownPct: 3, totalTrades: 7, winRate: 0.5, profitFactor: 1.2,
  sharpe: 1.1, avgTradePnlUsd: 14, topTradeContributionPct: 20, exposureHours: 5,
  holdoutSharpe: SENTINEL_NUM,
  promotion: { verdict: 'passed', evaluationWindow: { from: SENTINEL_DATE, to: SENTINEL_DATE } },
  // TOP-LEVEL window subtree — must be caught by the evaluation_window sequence,
  // not merely hidden under the removed promotion key:
  evaluationWindow: { from: SENTINEL_DATE, to: SENTINEL_DATE },
} as unknown as BacktestMetricBlock;

function assertClean(prompt: string): void {
  expect(prompt).not.toContain('holdout');
  expect(prompt).not.toContain('promotion');
  expect(prompt).not.toContain('evaluationWindow');
  expect(prompt).not.toContain(String(SENTINEL_NUM));
  expect(prompt).not.toContain(SENTINEL_DATE);
}

describe('WFO Mastra prompt builders — outcome embargo', () => {
  it('gate1 prompt scrubs embargo keys and keeps train metrics', async () => {
    const { agent, prompts } = capturingAgent({ decision: 'allow_exploratory_sweep', reason: 'r' });
    const input: Gate1Input = { profile, baselineMetrics: dirtyMetrics, entryAffecting: ['dump.minDropPct'], hasEntrySignalEvidence: true };
    await new MastraGate1(agent, 'test').decide(input);
    expect(prompts).toHaveLength(1);
    assertClean(prompts[0]!);
    expect(prompts[0]!).toContain('"netPnlUsd":100'); // positive control
  });

  it('sweep-designer prompt scrubs embargo keys and has no boundary-date field', async () => {
    const { agent, prompts } = capturingAgent({ grid: {}, rationale: 'r' });
    const input: SweepInput = {
      profile, baselineTrainSummary: dirtyMetrics,
      tunableParams: [], restrictToEntryParams: false, maxPoints: 4,
    };
    await new MastraSweepDesigner(agent, 'test').design(input);
    assertClean(prompts[0]!);
    expect(prompts[0]!).not.toContain('Period end'); // T line removed in Task 3
    expect(prompts[0]!).toContain('"sharpe":1.1');
  });

  it('result-interpreter prompt scrubs embargo keys nested inside topN', async () => {
    const { agent, prompts } = capturingAgent({ decision: 'stop' });
    const topN = [{
      paramsHash: 'ph1', point: { 'dump.minDropPct': 2 }, status: 'completed',
      metrics: dirtyMetrics, lowConfidence: false,
    }] as unknown as RankedPoint[];
    const input: InterpretInput = { topN, roundsSoFar: 1, maxRounds: 3 };
    await new MastraResultInterpreter(agent, 'test').interpret(input);
    assertClean(prompts[0]!);
    expect(prompts[0]!).toContain('ph1');
  });

  // R3 (research-validation-hardening item 3, report-13 gap G3): the interpreter must be told,
  // as an explicit fact (not just buried in the topN JSON dump), which points are lone peaks.
  it('result-interpreter prompt surfaces an explicit lone_peak fact when a ranked point is flagged', async () => {
    const { agent, prompts } = capturingAgent({ decision: 'stop' });
    const topN = [
      { paramsHash: 'lone1', point: { x: 1 }, status: 'completed', metrics: dirtyMetrics, lowConfidence: false, lonePeak: true },
      { paramsHash: 'ok1', point: { x: 2 }, status: 'completed', metrics: dirtyMetrics, lowConfidence: false, lonePeak: false },
    ] as unknown as RankedPoint[];
    const input: InterpretInput = { topN, roundsSoFar: 1, maxRounds: 3 };
    await new MastraResultInterpreter(agent, 'test').interpret(input);
    expect(prompts[0]!).toMatch(/lone peak/i);
    expect(prompts[0]!).toContain('lone1');
  });

  it('result-interpreter prompt reports no lone peaks when none are flagged', async () => {
    const { agent, prompts } = capturingAgent({ decision: 'stop' });
    const topN = [
      { paramsHash: 'ok1', point: { x: 2 }, status: 'completed', metrics: dirtyMetrics, lowConfidence: false, lonePeak: false },
    ] as unknown as RankedPoint[];
    const input: InterpretInput = { topN, roundsSoFar: 1, maxRounds: 3 };
    await new MastraResultInterpreter(agent, 'test').interpret(input);
    expect(prompts[0]!).toMatch(/lone peak.*none/i);
  });
});
