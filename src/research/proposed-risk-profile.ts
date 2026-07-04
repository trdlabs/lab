// Option B synthesis (#profile-management #3): full RiskProfile proposal = WFO-tuned exit/stop
// thresholds layered over neutral platform defaults. Lab owns only the EXIT shape (tp/sl/hold) that
// the analyst extracts and WFO tunes; SIZING and DCA counts are runner-owned (StrategyProfile
// .runnerOwnedAuthorities), so they default to the platform's neutral baseline (== platform 085
// 'default' preset). The platform CLAMPS this proposal into its guardrails on promotion (087), so
// lab-side defaults are always upper/lower-bounded there — lab never gets the final say on risk.
//
// Param naming is NOT standardized across strategies (hardStopPct vs risk.hardStopPct, tpLadder.tp1Pct
// vs exit.tpPct), so each stop field accepts a small alias list. A proposal is emitted ONLY when at
// least one recognized tuned stop is found — otherwise `undefined` (nothing meaningful to propose;
// the platform resolver default already applies).

/** Neutral defaults — mirror the platform 085 'default' preset (safe, clamp-compatible). */
const DEFAULT_SIZING = { baseOrderUsd: 100, dca1OrderUsd: 120, dca2OrderUsd: 150 } as const;
const DEFAULT_STOPS = { tp1Pct: 3.5, tp2Pct: 5, hardStopPct: 12, maxHoldMin: 180, moveStopToBEAfterTp1: true } as const;
const DEFAULT_DCA = { maxCount: 2, minDropFromLastEntryPct: 3 } as const;

/** Numeric stop field → accepted param-name aliases (lab strategy params are not standardized). */
const STOP_ALIASES = {
  tp1Pct: ['tpLadder.tp1Pct', 'exit.tp1Pct', 'exit.tpPct', 'tp1Pct'],
  tp2Pct: ['tpLadder.tp2Pct', 'exit.tp2Pct', 'tp2Pct'],
  hardStopPct: ['hardStopPct', 'risk.hardStopPct', 'exit.hardStopPct'],
  maxHoldMin: ['maxHoldMin', 'exit.maxHoldMin'],
} as const;

type StopField = keyof typeof STOP_ALIASES;

export interface DeriveProposedRiskInput {
  /** WFO champion tuned params (wfoHoldout.params) — primary source of tuned stop values. */
  readonly tunedParams?: Record<string, unknown> | undefined;
  /** Analyst-extracted profile parameters (StrategyProfile.profile.parameters) — fallback source. */
  readonly profileParams?: readonly { readonly name: string; readonly value: unknown }[] | undefined;
}

function asFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Read the first alias present (as a finite number) from tunedParams, then profileParams. */
function readStop(field: StopField, input: DeriveProposedRiskInput): number | undefined {
  const aliases = STOP_ALIASES[field];
  for (const key of aliases) {
    const fromTuned = asFiniteNumber(input.tunedParams?.[key]);
    if (fromTuned !== undefined) return fromTuned;
  }
  if (input.profileParams) {
    for (const key of aliases) {
      const hit = input.profileParams.find((p) => p.name === key);
      const val = asFiniteNumber(hit?.value);
      if (val !== undefined) return val;
    }
  }
  return undefined;
}

/**
 * Build a full RiskProfile proposal (Option B) from a champion's tuned exit/stop params over neutral
 * defaults. Returns `undefined` when no recognized tuned stop is present (no meaningful proposal).
 */
export function deriveProposedRiskProfile(input: DeriveProposedRiskInput): Record<string, unknown> | undefined {
  const overrides: Partial<Record<StopField, number>> = {};
  for (const field of Object.keys(STOP_ALIASES) as StopField[]) {
    const v = readStop(field, input);
    if (v !== undefined) overrides[field] = v;
  }
  if (Object.keys(overrides).length === 0) return undefined;

  return {
    sizing: { ...DEFAULT_SIZING },
    stops: { ...DEFAULT_STOPS, ...overrides },
    dca: { ...DEFAULT_DCA },
  };
}
