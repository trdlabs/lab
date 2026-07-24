/**
 * R13 (research-validation-hardening item 6): the log-only "onboarding battery" — a small,
 * DETERMINISTIC grid swept around a fresh strategy's baseline parameter values right after its
 * baseline validation passes and BEFORE the first full WFO round. Its only jobs are to (a) seed
 * the backtester's server-side trial ledger with a handful of neighbor points so the very first
 * DSR/plateau evidence isn't a single lone run, and (b) surface lone-peak-vs-plateau evidence
 * around the baseline as a log signal. It NEVER changes a verdict, status, or the
 * strategy.onboard → baseline → wfo chain.
 *
 * NO LLM: the grid is built mechanically from the profile's tunable params and the
 * `SWEEP_AXIS_CATALOG` (R13 Task 1) axis matchers — the sweep-designer agent is deliberately not
 * called here (YAGNI; onboarding wants a cheap deterministic bracket, not a designed sweep).
 *
 * Denylisted axes (today: leverage/margin — no liquidation model in the engine) are excluded
 * exactly like `validateSweepGrid`'s `denylisted_axis:*` gate, so a leverage param never enters
 * the battery grid even if the profile marks it tunable.
 *
 * Size is intentionally tiny — see `ONBOARD_BATTERY_MAX_POINTS`. Each grid point is a real
 * backtest submission; this stage pays for itself only if it stays cheap.
 */
import { expandGrid } from './param-grid.ts';
import { isDenylistedParam, SWEEP_AXIS_CATALOG } from './sweep-axis-catalog.ts';
import type { GridRunOutput } from './param-grid-runner.ts';
import type { ParameterGrid } from '../domain/research-experiment.ts';
import type { StrategyParameter } from '../domain/strategy-profile.ts';

/** Rollout mode. `enforce` intentionally absent — the onboarding battery is log-only by
 *  construction (it seeds the ledger and logs evidence; it never gates anything), mirroring
 *  `resolveBreakBatteryMode` / `resolveHypothesisHoldoutMode`. */
export type OnboardBatteryMode = 'off' | 'log';

/**
 * Fail-closed parser for LAB_ONBOARD_BATTERY_MODE (repo convention: a present-but-unrecognized
 * value is a deploy typo, not a request for the default). Mirrors `resolveHypothesisHoldoutMode`.
 * `enforce` is rejected EXPLICITLY: this stage has no enforce semantics — silently mapping it to
 * `log` (or `off`) would misstate what the flag does.
 */
export function resolveOnboardBatteryMode(raw: string | undefined): OnboardBatteryMode {
  if (raw === undefined || raw === '' || raw === 'off') return 'off';
  if (raw === 'log') return 'log';
  if (raw === 'enforce') {
    throw new Error(
      'LAB_ONBOARD_BATTERY_MODE=enforce is not available — the onboarding battery is log-only by '
      + 'design (seeds the trial ledger, never changes a verdict); calibration/enforce is out of '
      + 'scope (battery-policy@1, control-center docs/architecture/battery-policy.md). Use off|log.',
    );
  }
  throw new Error(`LAB_ONBOARD_BATTERY_MODE must be one of off|log, got '${raw}'`);
}

/**
 * Conservative ceiling on the onboarding grid's cartesian size. 12 is deliberately small: each
 * point is a real backtest run, this stage runs on EVERY fresh onboarding, and its purpose is a
 * cheap bracket around the baseline — not an exhaustive sweep (that's the WFO's job). With
 * ±STEP giving 3 values per axis, 12 admits at most 2 swept axes (3×3=9 ≤ 12; a 3rd axis would
 * be 27 > 12), which the greedy name-sorted selection in `buildOnboardBatteryGrid` enforces.
 */
export const ONBOARD_BATTERY_MAX_POINTS = 12;

/** Fractional perturbation applied on each side of a baseline value (±50%). Wide enough that the
 *  neighbor points can actually reveal a lone peak vs. a plateau, deterministic, unitless. */
export const ONBOARD_BATTERY_STEP = 0.5;

export interface OnboardBatteryGrid {
  /** The grid handed to `ParamGridRunner.runGrid` (a `Record<string, unknown[]>`). Empty `{}`
   *  when no eligible axis exists. */
  grid: ParameterGrid;
  /** Param names actually swept (grid keys), sorted. Empty ⇒ nothing to run. */
  axes: string[];
  /** `expandGrid(grid).length` — 0 when `axes` is empty (an empty grid expands to one no-op
   *  point, which we must NOT run). */
  pointCount: number;
}

/** True when a param name belongs to at least one NON-denylisted catalog axis. */
function matchesNonDenylistedAxis(name: string): boolean {
  return SWEEP_AXIS_CATALOG.some((axis) => axis.denylisted !== true && axis.matchesParam(name));
}

/** `[down, base, up]` around `v`, integer-preserving and deduped. Fewer than 2 distinct values
 *  (e.g. baseline 0, where both sides collapse to 0) ⇒ no sweep signal on this axis. */
function perturbValues(v: number, step: number): number[] {
  const preserveInt = Number.isInteger(v);
  // Integer baselines stay integers; float baselines are rounded to 6 dp so the grid carries clean,
  // deterministic values (2.4 * 1.5 === 3.5999999999999996 → 3.6) instead of FP noise into the
  // paramsHash / trial ledger.
  const norm = [v * (1 - step), v, v * (1 + step)].map((x) =>
    preserveInt ? Math.round(x) : Math.round(x * 1e6) / 1e6,
  );
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of norm) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * Builds the deterministic onboarding grid from a profile's tunable params. Selection rules:
 *  - param is `tunable`;
 *  - its baseline `value` is a finite number (string/bool/null params can't be bracketed
 *    numerically — out of scope, YAGNI);
 *  - it belongs to a non-denylisted catalog axis, AND is not denylisted (double guard — the
 *    leverage/margin axis never enters the grid);
 *  - the ±STEP bracket yields ≥ 2 distinct values.
 * Eligible params are taken in NAME order, greedily, while the running cartesian product stays
 * ≤ maxPoints (so a 3rd axis that would blow the ceiling is simply left out) — fully
 * deterministic, no LLM, no RNG.
 */
export function buildOnboardBatteryGrid(
  params: readonly StrategyParameter[] | undefined,
  opts: { maxPoints?: number; step?: number } = {},
): OnboardBatteryGrid {
  const maxPoints = opts.maxPoints ?? ONBOARD_BATTERY_MAX_POINTS;
  const step = opts.step ?? ONBOARD_BATTERY_STEP;

  const eligible = (params ?? [])
    .filter((p) => p.tunable)
    .filter((p): p is StrategyParameter & { value: number } => typeof p.value === 'number' && Number.isFinite(p.value))
    .filter((p) => matchesNonDenylistedAxis(p.name) && !isDenylistedParam(p.name))
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const grid: ParameterGrid = {};
  const axes: string[] = [];
  let product = 1;
  for (const p of eligible) {
    const values = perturbValues(p.value, step);
    if (values.length < 2) continue;
    const next = product * values.length;
    if (next > maxPoints) break;
    grid[p.name] = values;
    axes.push(p.name);
    product = next;
  }

  const pointCount = axes.length === 0 ? 0 : expandGrid(grid, maxPoints).length;
  return { grid, axes, pointCount };
}

/** Log-only summary of a battery run — COUNTS and boolean evidence only, never metric
 *  magnitudes (Outcome-Embargo spirit: no Sharpe/PnL leaks into events/artifacts here). */
export interface OnboardBatterySummary {
  /** Grid points submitted (= `expandGrid` length). */
  points: number;
  /** Points that completed (a backtest with a result). */
  completed: number;
  /** Points the runner rejected / left pending. */
  rejected: number;
  /** Points that survived ranking (completed with > 0 trades). */
  ranked: number;
  /** Ranked points flagged as a lone peak (overfit signature) — count only. */
  lonePeak: number;
  /** Ranked points NOT flagged lone-peak (plateau-ish) — count only. */
  plateau: number;
}

export function summarizeOnboardBatteryRun(output: GridRunOutput): OnboardBatterySummary {
  const completed = output.allResults.filter((r) => r.status === 'completed').length;
  const lonePeak = output.ranked.filter((r) => r.lonePeak).length;
  return {
    points: output.submitted,
    completed,
    rejected: output.rejected,
    ranked: output.ranked.length,
    lonePeak,
    plateau: output.ranked.length - lonePeak,
  };
}
