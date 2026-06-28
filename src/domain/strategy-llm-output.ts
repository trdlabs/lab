// src/domain/strategy-llm-output.ts
/**
 * Strict LLM-output schema for strategy authoring.
 *
 * OpenAI structured-output discipline (mirrors mastra-builder.ts `LlmBuilderOutputSchema`):
 *   - z.nullable() (not z.optional()) for optional-in-SDK fields → keeps them in JSON Schema
 *     `required`, satisfying OpenAI strict mode which requires all object keys to be present.
 *   - All object-valued fields with a closed key-set use explicit field declarations + .strict().
 *
 * `paramsSchema` and `params` are serialized as JSON strings (per the `files` precedent in
 *   mastra-builder.ts): the LLM emits them as JSON-encoded strings; the adapter parses them
 *   back to objects. This avoids `additionalProperties`-based schemas which OpenAI strict-mode
 *   rejects.
 */

import { z } from 'zod';
import type { StrategyBuilderOutput, StrategyManifestMeta } from '../ports/strategy-builder.port.ts';

// ---------------------------------------------------------------------------
// Nested object schemas (closed key-sets → strict-safe)
// ---------------------------------------------------------------------------

/**
 * CapabilityDeclaration from SDK — all fields optional booleans.
 * Modelled with .nullable() so OpenAI strict mode keeps each key in `required`.
 */
const CapabilityDeclarationSchema = z.object({
  exchangeDirect: z.boolean().nullable(),
  brokerDirect: z.boolean().nullable(),
  filesystem: z.boolean().nullable(),
  network: z.boolean().nullable(),
  process: z.boolean().nullable(),
  env: z.boolean().nullable(),
  dynamicEval: z.boolean().nullable(),
  platformSdk: z.boolean().nullable(),
}).strict();

/**
 * DataNeedsDeclaration from SDK — all fields optional booleans.
 * Same nullable-not-optional discipline for OpenAI strict mode.
 */
const DataNeedsDeclarationSchema = z.object({
  closedCandlesUpToCurrent: z.boolean().nullable(),
  asOfIndicators: z.boolean().nullable(),
  openInterest: z.boolean().nullable(),
  liquidations: z.boolean().nullable(),
  funding: z.boolean().nullable(),
  taker: z.boolean().nullable(),
  forwardBars: z.boolean().nullable(),
  forwardWindow: z.boolean().nullable(),
  oracle: z.boolean().nullable(),
  labeling: z.boolean().nullable(),
  postTradeOutcome: z.boolean().nullable(),
  wallClock: z.boolean().nullable(),
  uncontrolledRandom: z.boolean().nullable(),
}).strict();

// ---------------------------------------------------------------------------
// StrategyManifestSchema — mirrors CreateModuleManifestInput
// ---------------------------------------------------------------------------

/**
 * Hand-written zod mirror of CreateModuleManifestInput from @trading-backtester/sdk/builder,
 * with `kind` pinned to 'strategy' and optional SDK fields mapped to .nullable().
 *
 * Hooks restricted to the strategy lifecycle subset (task brief spec).
 */
export const StrategyManifestSchema = z.object({
  // Required fields (mirror SDK required)
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.literal('strategy'),
  name: z.string().min(1),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  hooks: z.array(z.enum(['init', 'onBarClose', 'onPositionBar', 'onPendingIntentBar', 'dispose'])),
  // Serialized as a JSON string (see module doc) — LLM emits JSON Schema as a JSON-encoded string
  paramsSchema: z.string(),
  capabilities: CapabilityDeclarationSchema,
  dataNeeds: DataNeedsDeclarationSchema,
  // Optional-in-SDK fields → .nullable() to satisfy OpenAI strict required-keys rule
  author: z.enum(['human', 'agent']).nullable(),
  status: z.enum(['research_only', 'reviewed', 'promoted']).nullable(),
  // Serialized as a JSON string or null (see module doc) — LLM emits params payload as JSON-encoded string
  params: z.string().nullable(),
  source: z.string().nullable(),
  targetStrategyRef: z.string().nullable(),
  interceptionPoint: z.string().nullable(),
}).strict();

// ---------------------------------------------------------------------------
// Top-level LLM output schema
// ---------------------------------------------------------------------------

/**
 * .strict() prevents the LLM from smuggling fields like `bundleHash` or `bytes`
 * that belong to the bundle layer, not the authoring layer.
 */
export const StrategyLlmOutputSchema = z.object({
  manifest: StrategyManifestSchema,
  source: z.string().min(1),
  notes: z.string().nullable(),
}).strict();

export type StrategyLlmOutput = z.infer<typeof StrategyLlmOutputSchema>;

// ---------------------------------------------------------------------------
// Adapter: LLM output → F1 StrategyBuilderOutput
// ---------------------------------------------------------------------------

/** Strip keys whose value is null — converts nullable-LLM booleans → optional-SDK booleans. */
function stripNullBooleans(
  obj: Record<string, boolean | null>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

/**
 * Convert a parsed StrategyLlmOutput into a StrategyBuilderOutput (F1 port).
 *
 * - Strips `kind` (supplied by the builder as 'strategy' when calling createModuleManifest).
 * - Converts nullable boolean objects (capabilities/dataNeeds) back to optional-boolean shape.
 * - Drops null-valued optional fields so the SDK sees undefined (absent), not null.
 */
export function llmToStrategyBuilderOutput(o: StrategyLlmOutput): StrategyBuilderOutput {
  const {
    kind: _,
    capabilities,
    dataNeeds,
    author,
    status,
    params,
    paramsSchema,
    source: manifestSource,
    targetStrategyRef,
    interceptionPoint,
    ...required
  } = o.manifest;

  const manifestMeta: StrategyManifestMeta = {
    ...required,
    paramsSchema: JSON.parse(paramsSchema) as object,
    capabilities: stripNullBooleans(capabilities) as StrategyManifestMeta['capabilities'],
    dataNeeds: stripNullBooleans(dataNeeds) as StrategyManifestMeta['dataNeeds'],
    ...(author !== null ? { author } : {}),
    ...(status !== null ? { status } : {}),
    ...(params !== null ? { params: JSON.parse(params) as object } : {}),
    ...(manifestSource !== null ? { source: manifestSource } : {}),
    ...(targetStrategyRef !== null ? { targetStrategyRef } : {}),
    ...(interceptionPoint !== null ? { interceptionPoint } : {}),
  };

  return { source: o.source, manifestMeta };
}
