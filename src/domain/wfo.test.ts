import { describe, expect, it } from 'vitest';

import { classifyEntryAffectingParams, validateSweepGrid } from './wfo.ts';

describe('classifyEntryAffectingParams', () => {
  it('classifies entry-affecting vs exit/risk params', () => {
    const r = classifyEntryAffectingParams([
      { name: 'dump.minDropPct', tunable: true },
      { name: 'entry.fastBouncePct', tunable: true },
      { name: 'tpLadder.tp1Pct', tunable: true },
      { name: 'hardStopPct', tunable: true },
      { name: 'maxHoldMin', tunable: true },
    ] as any);
    expect(r.entryAffecting.sort()).toEqual(['dump.minDropPct', 'entry.fastBouncePct']);
    expect(r.exitRisk).toContain('tpLadder.tp1Pct');
  });

  it('classifies oiFilter/liqFilter/watch.cooldown/warmup.maxSignalAge as entry-affecting', () => {
    const r = classifyEntryAffectingParams([
      { name: 'oiFilter.minOi', tunable: true },
      { name: 'liqFilter.minNotional', tunable: true },
      { name: 'watch.cooldownMin', tunable: true },
      { name: 'warmup.maxSignalAgeMin', tunable: true },
      { name: 'protection.maxDailyLossPct', tunable: true },
      { name: 'dca.stepPct', tunable: true },
      { name: 'failFast.maxAdverseExcursionPct', tunable: true },
    ] as any);
    expect(r.entryAffecting.sort()).toEqual([
      'liqFilter.minNotional',
      'oiFilter.minOi',
      'warmup.maxSignalAgeMin',
      'watch.cooldownMin',
    ]);
    expect(r.exitRisk.sort()).toEqual([
      'dca.stepPct',
      'failFast.maxAdverseExcursionPct',
      'protection.maxDailyLossPct',
    ]);
  });

  it('classifies by description keywords when the name does not match a prefix', () => {
    const r = classifyEntryAffectingParams([
      { name: 'customParam', tunable: true, description: 'Controls the entry signal filter cooldown' },
      { name: 'anotherParam', tunable: true, description: 'Unrelated risk sizing knob' },
    ] as any);
    expect(r.entryAffecting).toEqual(['customParam']);
    expect(r.exitRisk).toEqual(['anotherParam']);
  });

  it('ignores non-tunable params', () => {
    const r = classifyEntryAffectingParams([
      { name: 'entry.fastBouncePct', tunable: false },
      { name: 'tpLadder.tp1Pct', tunable: true },
    ] as any);
    expect(r.entryAffecting).toEqual([]);
    expect(r.exitRisk).toEqual(['tpLadder.tp1Pct']);
  });
});

describe('validateSweepGrid', () => {
  const tunableParamNames = ['entry.fastBouncePct', 'tpLadder.tp1Pct'];
  const entryAffecting = ['entry.fastBouncePct'];

  it('a valid grid restricted to tunable params → ok', () => {
    const r = validateSweepGrid(
      { 'entry.fastBouncePct': [1, 2], 'tpLadder.tp1Pct': [3, 4] },
      { tunableParamNames, restrictToEntryParams: false, entryAffecting },
    );
    expect(r).toEqual({ ok: true });
  });

  it('a key that is not a tunable param of the profile → non_tunable_param', () => {
    const r = validateSweepGrid(
      { 'entry.fastBouncePct': [1, 2], 'unknown.param': [1] },
      { tunableParamNames, restrictToEntryParams: false, entryAffecting },
    );
    expect(r).toEqual({ ok: false, reason: 'non_tunable_param:unknown.param' });
  });

  it('an exit-only key under restrictToEntryParams:true → non_entry_param_in_exploratory', () => {
    const r = validateSweepGrid(
      { 'tpLadder.tp1Pct': [1, 2] },
      { tunableParamNames, restrictToEntryParams: true, entryAffecting },
    );
    expect(r).toEqual({ ok: false, reason: 'non_entry_param_in_exploratory:tpLadder.tp1Pct' });
  });

  it('a key whose value array is empty → empty_values', () => {
    const r = validateSweepGrid(
      { 'entry.fastBouncePct': [] },
      { tunableParamNames, restrictToEntryParams: false, entryAffecting },
    );
    expect(r).toEqual({ ok: false, reason: 'empty_values:entry.fastBouncePct' });
  });

  it('an empty grid (no keys) → empty_grid', () => {
    const r = validateSweepGrid({}, { tunableParamNames, restrictToEntryParams: false, entryAffecting });
    expect(r).toEqual({ ok: false, reason: 'empty_grid' });
  });

  // R13 (research-validation-hardening item 6, report-13 G13/§3.5): leverage is denylisted from
  // any sweep grid until the engine has a liquidation model — a systematic gate, independent of
  // whether the profile happens to mark the param tunable.
  it('a leverage-named key → denylisted_axis, even when it is a declared tunable param', () => {
    const r = validateSweepGrid(
      { 'leverage.multiplier': [1, 2] },
      { tunableParamNames: ['leverage.multiplier'], restrictToEntryParams: false, entryAffecting: [] },
    );
    expect(r).toEqual({ ok: false, reason: 'denylisted_axis:leverage.multiplier' });
  });

  it('a margin-named key → denylisted_axis', () => {
    const r = validateSweepGrid(
      { marginMode: [1, 2] },
      { tunableParamNames: ['marginMode'], restrictToEntryParams: false, entryAffecting: [] },
    );
    expect(r).toEqual({ ok: false, reason: 'denylisted_axis:marginMode' });
  });

  it('a leverage-named key that is NOT a declared tunable param → denylisted_axis takes priority over non_tunable_param', () => {
    const r = validateSweepGrid(
      { 'leverage.multiplier': [1, 2] },
      { tunableParamNames, restrictToEntryParams: false, entryAffecting },
    );
    expect(r).toEqual({ ok: false, reason: 'denylisted_axis:leverage.multiplier' });
  });

  it('existing reasons are unaffected by the denylist check', () => {
    expect(validateSweepGrid(
      { 'entry.fastBouncePct': [1, 2], 'tpLadder.tp1Pct': [3, 4] },
      { tunableParamNames, restrictToEntryParams: false, entryAffecting },
    )).toEqual({ ok: true });
    expect(validateSweepGrid(
      { 'entry.fastBouncePct': [1, 2], 'unknown.param': [1] },
      { tunableParamNames, restrictToEntryParams: false, entryAffecting },
    )).toEqual({ ok: false, reason: 'non_tunable_param:unknown.param' });
    expect(validateSweepGrid(
      { 'tpLadder.tp1Pct': [1, 2] },
      { tunableParamNames, restrictToEntryParams: true, entryAffecting },
    )).toEqual({ ok: false, reason: 'non_entry_param_in_exploratory:tpLadder.tp1Pct' });
    expect(validateSweepGrid(
      { 'entry.fastBouncePct': [] },
      { tunableParamNames, restrictToEntryParams: false, entryAffecting },
    )).toEqual({ ok: false, reason: 'empty_values:entry.fastBouncePct' });
    expect(validateSweepGrid({}, { tunableParamNames, restrictToEntryParams: false, entryAffecting }))
      .toEqual({ ok: false, reason: 'empty_grid' });
  });
});
