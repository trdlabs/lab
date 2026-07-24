import { describe, expect, it } from 'vitest';

import {
  ONBOARD_BATTERY_MAX_POINTS,
  ONBOARD_BATTERY_STEP,
  buildOnboardBatteryGrid,
  resolveOnboardBatteryMode,
  summarizeOnboardBatteryRun,
} from './onboard-battery.ts';
import type { StrategyParameter } from '../domain/strategy-profile.ts';
import type { GridRunOutput } from './param-grid-runner.ts';
import type { GridResult, RankedPoint } from './top-n-prefilter.ts';

function param(over: Partial<StrategyParameter> & { name: string }): StrategyParameter {
  return { value: 10, unit: null, description: '', tunable: true, ...over };
}

describe('resolveOnboardBatteryMode', () => {
  it("defaults to 'off' on undefined / empty / 'off'", () => {
    expect(resolveOnboardBatteryMode(undefined)).toBe('off');
    expect(resolveOnboardBatteryMode('')).toBe('off');
    expect(resolveOnboardBatteryMode('off')).toBe('off');
  });

  it("accepts 'log'", () => {
    expect(resolveOnboardBatteryMode('log')).toBe('log');
  });

  it("fail-closed: 'enforce' throws (log-only stage) and unknown values throw off|log", () => {
    expect(() => resolveOnboardBatteryMode('enforce')).toThrow(/enforce/);
    expect(() => resolveOnboardBatteryMode('enforce')).toThrow(/battery-policy/);
    expect(() => resolveOnboardBatteryMode('bogus')).toThrow(/off\|log/);
  });
});

describe('buildOnboardBatteryGrid', () => {
  it('returns an empty grid (no axes) for undefined / empty / no-tunable params', () => {
    expect(buildOnboardBatteryGrid(undefined)).toMatchObject({ axes: [], pointCount: 0 });
    expect(buildOnboardBatteryGrid([])).toMatchObject({ axes: [], pointCount: 0 });
    expect(buildOnboardBatteryGrid([param({ name: 'maxHoldMin', tunable: false })])).toMatchObject({ axes: [], pointCount: 0 });
  });

  it('brackets a tunable numeric axis with [down, base, up] (integer-preserving)', () => {
    const built = buildOnboardBatteryGrid([param({ name: 'maxHoldMin', value: 60 })]);
    expect(built.axes).toEqual(['maxHoldMin']);
    expect(built.grid.maxHoldMin).toEqual([30, 60, 90]);
    expect(built.pointCount).toBe(3);
  });

  it('keeps float baselines as floats (non-integer baseline skips the int-rounding path)', () => {
    const built = buildOnboardBatteryGrid([param({ name: 'dump.minDropPct', value: 2.4 })], { step: 0.5 });
    expect(built.grid['dump.minDropPct']).toEqual([1.2, 2.4, 3.6]);
  });

  it('EXCLUDES denylisted (leverage/margin) params even when tunable', () => {
    const built = buildOnboardBatteryGrid([
      param({ name: 'maxHoldMin', value: 60 }),
      param({ name: 'leverage.multiplier', value: 3 }),
      param({ name: 'marginMode', value: 2 }),
    ]);
    expect(built.axes).toEqual(['maxHoldMin']);
    expect(Object.keys(built.grid)).not.toContain('leverage.multiplier');
    expect(Object.keys(built.grid)).not.toContain('marginMode');
  });

  it('excludes params that match no catalog axis', () => {
    const built = buildOnboardBatteryGrid([param({ name: 'someRandomKnob', value: 5 })]);
    expect(built.axes).toEqual([]);
  });

  it('skips axes whose bracket collapses to a single value (e.g. baseline 0)', () => {
    const built = buildOnboardBatteryGrid([param({ name: 'maxHoldMin', value: 0 })]);
    expect(built.axes).toEqual([]);
  });

  it('caps the cartesian product at maxPoints — greedy in NAME order (3rd axis dropped)', () => {
    // Three eligible axes, 3 values each -> 3*3*3 = 27 > 12; only the first two (by name) survive.
    const built = buildOnboardBatteryGrid([
      param({ name: 'watch.cooldownMin', value: 10 }),
      param({ name: 'maxHoldMin', value: 60 }),
      param({ name: 'dump.minDropPct', value: 4 }),
    ]);
    expect(built.pointCount).toBeLessThanOrEqual(ONBOARD_BATTERY_MAX_POINTS);
    // name order: dump.minDropPct < maxHoldMin < watch.cooldownMin
    expect(built.axes).toEqual(['dump.minDropPct', 'maxHoldMin']);
    expect(built.pointCount).toBe(9);
  });

  it('is deterministic — identical input yields identical grid', () => {
    const inp = [param({ name: 'maxHoldMin', value: 60 }), param({ name: 'dump.minDropPct', value: 4 })];
    expect(buildOnboardBatteryGrid(inp)).toEqual(buildOnboardBatteryGrid(inp));
  });

  it('uses the default step/maxPoints constants', () => {
    expect(ONBOARD_BATTERY_STEP).toBe(0.5);
    expect(ONBOARD_BATTERY_MAX_POINTS).toBe(12);
  });
});

describe('summarizeOnboardBatteryRun', () => {
  function completed(id: string, lonePeak: boolean): RankedPoint {
    return {
      point: { x: id }, paramsHash: id, status: 'completed', strategyBacktestRunId: id,
      metrics: { totalTrades: 5, sharpe: 1, profitFactor: 1, maxDrawdownPct: 1, netPnlPct: 1 } as RankedPoint['metrics'],
      lowConfidence: false, lonePeak, neighborCount: 2,
    };
  }
  function rejected(id: string): GridResult {
    return { point: { x: id }, paramsHash: id, status: 'rejected', strategyBacktestRunId: id };
  }

  it('reports counts and lone-peak/plateau split — no magnitudes', () => {
    const ranked = [completed('a', false), completed('b', true), completed('c', false)];
    const output: GridRunOutput = {
      allResults: [...ranked, rejected('d')],
      ranked,
      submitted: 4,
      rejected: 1,
    };
    const summary = summarizeOnboardBatteryRun(output);
    expect(summary).toEqual({ points: 4, completed: 3, rejected: 1, ranked: 3, lonePeak: 1, plateau: 2 });
    // guard: only counts/booleans leak — no sharpe/pnl keys
    expect(JSON.stringify(summary)).not.toMatch(/sharpe|pnl|drawdown/i);
  });
});
