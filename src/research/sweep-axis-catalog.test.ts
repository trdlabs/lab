import { describe, expect, it } from 'vitest';

import {
  SWEEP_AXIS_CATALOG,
  SWEEP_AXIS_CATALOG_PROMPT,
  isDenylistedParam,
} from './sweep-axis-catalog.ts';

describe('SWEEP_AXIS_CATALOG_PROMPT', () => {
  it('states the plateau-not-peak and degradation-point rules', () => {
    expect(SWEEP_AXIS_CATALOG_PROMPT).toMatch(/wide plateau, not (a )?peak/i);
    expect(SWEEP_AXIS_CATALOG_PROMPT).toMatch(/degradation point/i);
  });

  it('names every non-denylisted axis from report-13 G13', () => {
    for (const marker of ['hold time', 'entry threshold', 'stop', 'take', 'cooldown', 'sizing', 'regime']) {
      expect(SWEEP_AXIS_CATALOG_PROMPT.toLowerCase()).toContain(marker);
    }
  });

  it('denylists the leverage axis until a liquidation model exists', () => {
    expect(SWEEP_AXIS_CATALOG_PROMPT).toMatch(/leverage/i);
    expect(SWEEP_AXIS_CATALOG_PROMPT).toMatch(/liquidation/i);
    expect(SWEEP_AXIS_CATALOG_PROMPT.toLowerCase()).toMatch(/never (sweep|include|propose).{0,40}leverage|leverage.{0,40}(denylist|forbidden|never)/);
  });
});

describe('SWEEP_AXIS_CATALOG', () => {
  it('marks exactly one axis denylisted — leverage', () => {
    const denylisted = SWEEP_AXIS_CATALOG.filter((a) => a.denylisted === true);
    expect(denylisted).toHaveLength(1);
    expect(denylisted[0]!.axis).toBe('leverage');
  });

  it('every axis has a non-empty promptGuidance string', () => {
    for (const a of SWEEP_AXIS_CATALOG) {
      expect(a.promptGuidance.length).toBeGreaterThan(0);
    }
  });

  it('covers the six onboarding axes plus the denylisted leverage axis', () => {
    expect(SWEEP_AXIS_CATALOG.map((a) => a.axis).sort()).toEqual([
      'cooldown',
      'entry_thresholds',
      'hold_time',
      'leverage',
      'regime_as_axis',
      'sizing',
      'stops_takes',
    ]);
  });

  it('matchesParam classifies real profile param names deterministically', () => {
    const byAxis = Object.fromEntries(SWEEP_AXIS_CATALOG.map((a) => [a.axis, a]));

    expect(byAxis.hold_time!.matchesParam('maxHoldMin')).toBe(true);
    expect(byAxis.hold_time!.matchesParam('entry.fastBouncePct')).toBe(false);

    expect(byAxis.entry_thresholds!.matchesParam('dump.minDropPct')).toBe(true);
    expect(byAxis.entry_thresholds!.matchesParam('entry.fastBouncePct')).toBe(true);
    expect(byAxis.entry_thresholds!.matchesParam('oiFilter.minOi')).toBe(true);
    expect(byAxis.entry_thresholds!.matchesParam('liqFilter.minNotional')).toBe(true);
    expect(byAxis.entry_thresholds!.matchesParam('tpLadder.tp1Pct')).toBe(false);

    expect(byAxis.stops_takes!.matchesParam('hardStopPct')).toBe(true);
    expect(byAxis.stops_takes!.matchesParam('tpLadder.tp1Pct')).toBe(true);
    expect(byAxis.stops_takes!.matchesParam('dump.minDropPct')).toBe(false);

    expect(byAxis.cooldown!.matchesParam('watch.cooldownMin')).toBe(true);
    expect(byAxis.cooldown!.matchesParam('warmup.maxSignalAgeMin')).toBe(true);
    expect(byAxis.cooldown!.matchesParam('entry.fastBouncePct')).toBe(false);

    expect(byAxis.sizing!.matchesParam('dca.stepPct')).toBe(true);
    expect(byAxis.sizing!.matchesParam('positionSizePct')).toBe(true);
    expect(byAxis.sizing!.matchesParam('hardStopPct')).toBe(false);

    expect(byAxis.regime_as_axis!.matchesParam('regimeFilter.enabled')).toBe(true);
    expect(byAxis.regime_as_axis!.matchesParam('dump.minDropPct')).toBe(false);

    expect(byAxis.leverage!.matchesParam('leverage.multiplier')).toBe(true);
    expect(byAxis.leverage!.matchesParam('marginMode')).toBe(true);
    expect(byAxis.leverage!.matchesParam('hardStopPct')).toBe(false);
  });
});

describe('isDenylistedParam', () => {
  it('flags leverage/margin-named params', () => {
    expect(isDenylistedParam('leverage.multiplier')).toBe(true);
    expect(isDenylistedParam('marginMode')).toBe(true);
    expect(isDenylistedParam('positionLeveragePct')).toBe(true);
  });

  it('does not flag unrelated tunable params', () => {
    expect(isDenylistedParam('entry.fastBouncePct')).toBe(false);
    expect(isDenylistedParam('tpLadder.tp1Pct')).toBe(false);
    expect(isDenylistedParam('dump.minDropPct')).toBe(false);
    expect(isDenylistedParam('maxHoldMin')).toBe(false);
  });
});
