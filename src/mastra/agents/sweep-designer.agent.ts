import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';
import { SWEEP_AXIS_CATALOG_PROMPT } from '../../research/sweep-axis-catalog.ts';

export const SWEEP_DESIGNER_AGENT_ID = 'sweep-designer';

const BASE_INSTRUCTIONS = [
  'You design a small parameter sweep grid for a walk-forward-optimization (WFO) round over a trading strategy.',
  'Given the tunable params and the baseline train-period metrics, propose a COMBINED grid (a map of param name to a short',
  'array of candidate values) spanning at most a few points per param and a modest total cartesian size — this is meant to be',
  'cheap to run, not exhaustive. Prefer values bracketing the current baseline value (e.g. below/above it) over arbitrary ones.',
  'When restrictToEntryParams is true, ONLY include entry-affecting params (params that can change whether trades fire at all,',
  'e.g. entry filters, dump/OI/liquidation filters, cooldowns) — exclude exit/risk-only params from the grid in that case.',
  'NEVER propose a leverage or margin axis — it is denylisted until the engine has a liquidation model (see below).',
  'Always give a short "rationale" string explaining why these params and ranges were chosen.',
].join(' ');

// R13 (research-validation-hardening item 6, report-13 G13): appends the deterministic axis
// catalog — best-practice axes to sweep at onboarding, the "wide plateau, not a peak" +
// "degradation point" rules, and the leverage denylist — same pattern as
// RESEARCHER_INSTRUCTIONS embedding RESEARCHER_CAPABILITIES.
export const SWEEP_DESIGNER_INSTRUCTIONS = `${BASE_INSTRUCTIONS}\n\n${SWEEP_AXIS_CATALOG_PROMPT}`;

export function createSweepDesignerAgent(model: ProviderModel): Agent {
  return new Agent({ id: SWEEP_DESIGNER_AGENT_ID, name: 'SweepDesigner', instructions: SWEEP_DESIGNER_INSTRUCTIONS, model });
}
