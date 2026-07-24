/**
 * R13 (research-validation-hardening item 6, report-13 gap G13): a deterministically-checkable
 * catalog of sweep-grid axes for onboarding a new strategy. The `sweep-designer` prompt is
 * intentionally minimal for WFO rounds ("cheap to run, not exhaustive, bracket the baseline") —
 * correct there, but it leaves onboarding without a best-practice sweep over the axes that
 * actually matter (hold time, entry thresholds, stops/takes, cooldown, sizing, regime-as-axis),
 * without a requirement to look for a plateau (not a peak) and the parameter's degradation
 * point, and without a denylist for the leverage axis.
 *
 * `leverage` is DENYLISTED: the engine has no margin/liquidation model (report-13 G7, §3 point
 * 5) — sweeping leverage without one is a systematic look-ahead bias, since a leveraged run
 * "survives" drawdowns that would have triggered a real liquidation. Denylisted until a
 * liquidation model lands in the engine (P2); today the axis is simply forbidden.
 *
 * Numeric thresholds are deliberately absent here: the only pinned battery thresholds are
 * `battery-policy@1` (DSR 0.95 / WFE 0.5 / plateau 0.5× peak — control-center
 * `docs/architecture/battery-policy.md`), which govern the post-hoc break-battery (R11), not
 * grid design. This catalog only prescribes WHICH axes to sweep and the plateau/degradation
 * shape to look for — not a magnitude.
 */

export interface SweepAxis {
  /** Stable machine-readable axis id (snake_case). */
  axis: string;
  /** Prompt-ready guidance for this axis — folded into SWEEP_AXIS_CATALOG_PROMPT verbatim. */
  promptGuidance: string;
  /** Does a given profile param name belong to this axis? Deterministic, no LLM involved. */
  matchesParam(name: string): boolean;
  /** true only for axes that must never be swept today (see module doc). */
  denylisted?: boolean;
}

/** Case-insensitive "prefix OR substring" name matcher — mirrors the style of
 *  `ENTRY_AFFECTING_NAME_PREFIXES` in `src/domain/wfo.ts`, extended with substrings for axes
 *  that aren't tied to a fixed namespace prefix (e.g. `hardStopPct`, `positionSizePct`). */
function nameMatcher(prefixes: readonly string[], substrings: readonly string[]) {
  return (name: string): boolean => {
    if (prefixes.some((prefix) => name.startsWith(prefix))) return true;
    const lower = name.toLowerCase();
    return substrings.some((s) => lower.includes(s));
  };
}

export const SWEEP_AXIS_CATALOG: readonly SweepAxis[] = [
  {
    axis: 'hold_time',
    promptGuidance:
      'Hold time — sweep the max/target holding duration (e.g. maxHoldMin) around the baseline. '
      + 'A strategy whose edge only survives at one exact hold time is fragile; look for a wide '
      + 'plateau, not a peak, and include a point past the point where performance starts to degrade.',
    matchesParam: nameMatcher(['hold.'], ['maxhold', 'holdtime', 'holdmin', 'holdbar']),
  },
  {
    axis: 'entry_thresholds',
    promptGuidance:
      'Entry thresholds — sweep entry-signal filter thresholds (dump/entry/OI/liquidation filters, '
      + 'e.g. dump.minDropPct, entry.fastBouncePct, oiFilter.minOi, liqFilter.minNotional). Bracket the '
      + 'baseline on both sides and include the expected degradation point (too loose → noise trades, '
      + 'too tight → starves the strategy of trades) rather than stopping at the current value.',
    matchesParam: nameMatcher(['dump.', 'entry.', 'oiFilter.', 'liqFilter.'], []),
  },
  {
    axis: 'stops_takes',
    promptGuidance:
      'Stops/takes — sweep stop-loss and take-profit levels (e.g. hardStopPct, tpLadder.tp1Pct). '
      + 'A single sharp optimum here is a red flag for overfitting; prefer a grid wide enough to reveal '
      + 'a plateau of acceptable values and the degradation point where the exit starts hurting returns.',
    matchesParam: nameMatcher(['tpLadder.'], ['stop', 'take', 'tp1', 'tp2', 'tpladder']),
  },
  {
    axis: 'cooldown',
    promptGuidance:
      'Cooldown — sweep post-signal cooldown / warmup windows (e.g. watch.cooldownMin, '
      + 'warmup.maxSignalAgeMin). Too short re-enters on the same move; too long misses the next one — '
      + 'sweep enough points to see both failure modes, not just the current setting.',
    matchesParam: nameMatcher(['watch.cooldown', 'warmup.maxSignalAge'], ['cooldown']),
  },
  {
    axis: 'sizing',
    promptGuidance:
      'Sizing — sweep position-sizing / DCA step params (e.g. dca.stepPct, positionSizePct). Sizing '
      + 'interacts with drawdown and the risk/reward tradeoff is the researcher\'s job to surface, not '
      + 'to pick a winner by Sharpe alone; report the plateau, not just the top point.',
    matchesParam: nameMatcher(['dca.'], ['positionsize', 'sizepct']),
  },
  {
    axis: 'regime_as_axis',
    promptGuidance:
      'Regime-as-axis — when the profile has a regime/market-condition filter, sweep it as a first-class '
      + 'axis (e.g. regimeFilter.enabled, regime thresholds) instead of leaving it fixed. A strategy that '
      + 'only works in one regime needs that stated explicitly, not discovered later in paper trading.',
    matchesParam: nameMatcher(['regime.', 'regimeFilter.'], ['regime']),
  },
  {
    axis: 'leverage',
    denylisted: true,
    promptGuidance:
      'Leverage — DENYLISTED. Never sweep, propose, or include a leverage/margin axis in a grid: the '
      + 'engine has no margin/liquidation model, so a leveraged backtest systematically survives '
      + 'drawdowns that would have been liquidated in reality (look-ahead bias). This is forbidden until '
      + 'a liquidation model exists in the engine — do not propose leverage params even as a stretch axis.',
    matchesParam: nameMatcher(['leverage.', 'margin.'], ['leverage', 'margin']),
  },
];

/** Non-axis-specific rules the sweep-designer prompt must always carry, regardless of which
 *  axes apply to a given profile. */
const CATALOG_RULES = [
  'AXIS CATALOG — when designing an onboarding sweep, draw candidate axes from this catalog '
  + '(hold time, entry thresholds, stops/takes, cooldown, sizing, regime-as-axis) rather than only '
  + 'the params that happen to be tunable in isolation.',
  'For every swept axis, look for a wide plateau, not a peak: a single isolated best value that is '
  + 'much better than its neighbors is evidence of overfitting, not of a real edge.',
  'Always include the expected degradation point of each swept parameter — a value past where '
  + 'performance is known or expected to fall off — not only values near the current baseline.',
].join(' ');

/** Full prompt-ready text: per-axis guidance + the plateau/degradation rules + the leverage
 *  denylist, in one string so sweep-designer.agent.ts and researcher-capabilities.ts can embed
 *  it verbatim (pattern: RESEARCHER_CAPABILITIES / RESEARCHER_INSTRUCTIONS). */
export const SWEEP_AXIS_CATALOG_PROMPT = [
  CATALOG_RULES,
  ...SWEEP_AXIS_CATALOG.map((a) => a.promptGuidance),
].join('\n');

/** Denylisted axes only (today: leverage). Exported so callers that need the catalog restricted
 *  to enforcement — not just prompt text — don't have to re-derive the filter. */
export const DENYLISTED_SWEEP_AXES: readonly SweepAxis[] = SWEEP_AXIS_CATALOG.filter((a) => a.denylisted === true);

/** True when a profile param name belongs to any denylisted axis (today: leverage/margin
 *  naming). Used by `validateSweepGrid` (src/domain/wfo.ts) to reject a grid key deterministically,
 *  independent of whether the param happens to be marked `tunable` in the profile. */
export function isDenylistedParam(name: string): boolean {
  return DENYLISTED_SWEEP_AXES.some((axis) => axis.matchesParam(name));
}
