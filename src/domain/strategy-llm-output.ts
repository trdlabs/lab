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

// `capabilities` and `dataNeeds` are serialized as JSON strings (same `params`/`paramsSchema`
// precedent below). Originally modelled as nested objects of 8 + 13 `.nullable()` booleans — but that
// is 21 union-typed parameters, which exceeds Anthropic structured-output's 16-union limit (OpenAI has
// no such cap). JSON-string fields are opaque to the provider's schema compiler → provider-portable
// (works on OpenAI, Anthropic, DeepSeek, …). The LLM emits a JSON object string; the adapter parses it.

// ---------------------------------------------------------------------------
// StrategyManifestSchema — mirrors CreateModuleManifestInput
// ---------------------------------------------------------------------------

/**
 * Hand-written zod mirror of CreateModuleManifestInput from @trdlabs/backtester-sdk/builder,
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
  // Deliberately broader than the agent's authoring instructions (which steer the LLM toward
  // onBarClose/onPositionBar): the schema accepts every valid SDK lifecycle hook so hand- or
  // refiner-authored manifests parse. The real semantic gate is L2 validateStrategyBundle (F2b).
  hooks: z.array(z.enum(['init', 'onBarClose', 'onPositionBar', 'onPendingIntentBar', 'dispose'])),
  // Serialized as a JSON string (see module doc) — LLM emits JSON Schema as a JSON-encoded string
  paramsSchema: z.string(),
  // JSON-encoded object strings (provider-portable; see note above) — adapter parses + strips nulls.
  capabilities: z.string(),
  dataNeeds: z.string(),
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

/** Parse a JSON-string field to an object, failing fast on JSON-valid-but-non-object payloads
 *  (e.g. "5", "null", "[]") that JSON.parse + `as object` would otherwise smuggle downstream. */
function parseJsonObject(json: string, field: string): object {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${field} must be a JSON object, got: ${json}`);
  }
  return parsed;
}

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
    paramsSchema: parseJsonObject(paramsSchema, 'paramsSchema'),
    capabilities: stripNullBooleans(parseJsonObject(capabilities, 'capabilities') as Record<string, boolean | null>) as StrategyManifestMeta['capabilities'],
    dataNeeds: stripNullBooleans(parseJsonObject(dataNeeds, 'dataNeeds') as Record<string, boolean | null>) as StrategyManifestMeta['dataNeeds'],
    ...(author !== null ? { author } : {}),
    ...(status !== null ? { status } : {}),
    ...(params !== null ? { params: parseJsonObject(params, 'params') } : {}),
    ...(manifestSource !== null ? { source: manifestSource } : {}),
    ...(targetStrategyRef !== null ? { targetStrategyRef } : {}),
    ...(interceptionPoint !== null ? { interceptionPoint } : {}),
  };

  return { source: o.source, manifestMeta };
}
