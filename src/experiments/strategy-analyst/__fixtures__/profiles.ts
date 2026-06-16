// src/experiments/strategy-analyst/__fixtures__/profiles.ts
import type { AnalystProfileOutput } from '../../../domain/strategy-profile.ts';

/** A strong long_oi profile that should PASS every check. Mirrors research-notes §4–13. */
export const GOOD_LONG_OI_PROFILE: AnalystProfileOutput = {
  direction: 'long',
  coreIdea: 'Long-only mean-reversion: after a sharp dump, enter on a confirmed bounce backed by OI recovery and long liquidations.',
  summary: 'Rule-based FSM on 1m candles. Detects a dump, watches for reversal, enters long when price rises, open interest recovers and long liquidations are present.',
  requiredMarketFeatures: ['ohlcv', 'open interest', 'liquidations'],
  entryConditions: [
    'Dump of >=10% detected over the lookback window',
    'Bounce/reversal from the local low confirmed by green candles',
    'Open interest (OI) recovering',
    'Long liquidations present',
  ],
  exitConditions: [
    'TP1 at +3.5% (partial 50%)',
    'TP2 at +5% (full exit)',
    'Hard stop (SL) at -12%',
    'Time exit after 180 minutes',
  ],
  timeframes: ['1m'],
  indicators: [],
  parameters: [
    { name: 'dump.minDropPct', value: 10, unit: '%', description: 'Minimum drop to trigger', tunable: true },
    { name: 'tpLadder.tp1Pct', value: 3.5, unit: '%', description: 'First take profit', tunable: true },
  ],
  watchLifecycleSummary: 'IDLE -> WATCHING -> IN_POSITION -> COOLDOWN.',
  positionManagementSummary: 'DCA averaging up to two adds on further dips; move stop to breakeven (BE) after TP1.',
  riskManagementSummary: 'Risk sizing, leverage and fills are owned by the runner/platform; the strategy only emits a sizing hint for DCA.',
  runnerOwnedAuthorities: ['position sizing', 'leverage', 'fills', 'execution'],
  confidence: 0.8,
  unknowns: [
    'Exact position sizing and leverage are not specified',
    'Fees/commissions are not specified',
    'Target exchange/venue is not specified',
    'Instrument universe (which symbols) is not specified',
  ],
  evidence: ['"Торгую только в long"', '"первый тейк на +3.5%"'],
};

/** Same as GOOD but direction flipped -> gate 2 fails. */
export const SHORT_DIRECTION_PROFILE: AnalystProfileOutput = { ...GOOD_LONG_OI_PROFILE, direction: 'short' };

/** GOOD but riskManagementSummary fabricates leverage + base size -> check 5 = 0. */
export const FABRICATED_RISK_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  riskManagementSummary: 'Use 10x leverage with a base order size of $100 per entry.',
};

/** GOOD but DCA size hints (1.2x/1.5x) mentioned in risk text -> must NOT trip check 5. */
export const DCA_HINT_RISK_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  riskManagementSummary: 'Sizing is host-owned. DCA adds use sizing hints of 1.2x then 1.5x of the prior size.',
};

/** GOOD but exitConditions omit TP2 -> check 3 partial credit. */
export const MISSING_TP2_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  exitConditions: ['TP1 at +3.5%', 'Hard stop (SL) at -12%', 'Time exit after 180 minutes'],
};

/** GOOD but DCA/BE only in summary, positionManagementSummary empty -> check 4 via fallback. */
export const POSMGMT_IN_SUMMARY_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  summary: GOOD_LONG_OI_PROFILE.summary + ' It uses DCA averaging and moves the stop to breakeven after TP1.',
  positionManagementSummary: null,
};

/** Russian-only phrasing for entry/exit/posmgmt -> synonym buckets must still hit. */
export const RU_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  requiredMarketFeatures: ['свечи ohlcv', 'открытый интерес (oi)', 'ликвидации'],
  entryConditions: ['пролив более 10%', 'отскок от минимума, две зелёные свечи', 'восстановление oi', 'присутствуют long-ликвидации'],
  exitConditions: ['первый тейк +3.5%', 'второй тейк +5%', 'жёсткий стоп -12%', 'выход по времени 180 минут'],
  positionManagementSummary: 'Усреднение (DCA) до двух доливок; перенос стопа в безубыток после TP1.',
};
