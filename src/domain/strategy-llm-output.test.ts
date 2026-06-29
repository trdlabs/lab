// src/domain/strategy-llm-output.test.ts
import { describe, it, expect } from 'vitest';
import { StrategyLlmOutputSchema, llmToStrategyBuilderOutput } from './strategy-llm-output.ts';
import { createModuleManifest } from '@trading-backtester/sdk/builder';

/** OpenAI-strict-shaped fixture: all nullable fields present (possibly null). */
const VALID_MANIFEST = {
  id: 'strat-001',
  version: '1.0.0',
  kind: 'strategy' as const,
  name: 'Test Strategy',
  summary: 'A test strategy for unit verification',
  rationale: 'Validates the schema + adapter contract',
  hooks: ['onBarClose'] as const,
  paramsSchema: JSON.stringify({ type: 'object', additionalProperties: false }),
  capabilities: JSON.stringify({
    exchangeDirect: null,
    brokerDirect: null,
    filesystem: null,
    network: null,
    process: null,
    env: null,
    dynamicEval: null,
    platformSdk: true,
  }),
  dataNeeds: JSON.stringify({
    closedCandlesUpToCurrent: true,
    asOfIndicators: null,
    openInterest: null,
    liquidations: null,
    funding: null,
    taker: null,
    forwardBars: null,
    forwardWindow: null,
    oracle: null,
    labeling: null,
    postTradeOutcome: null,
    wallClock: null,
    uncontrolledRandom: null,
  }),
  author: 'agent' as const,
  status: 'research_only' as const,
  params: null,
  source: null,
  targetStrategyRef: null,
  interceptionPoint: null,
};

const VALID_OUTPUT = {
  manifest: VALID_MANIFEST,
  source: `export default function createStrategyModule(params) {
  return {
    onBarClose(ctx) { return { kind: 'idle' }; },
  };
}`,
  notes: null,
};

describe('StrategyLlmOutputSchema', () => {
  it('(a) parses a valid LLM output', () => {
    const parsed = StrategyLlmOutputSchema.parse(VALID_OUTPUT);
    expect(parsed.manifest.kind).toBe('strategy');
    expect(parsed.manifest.id).toBe('strat-001');
  });

  it('(b) throws on smuggled top-level field (bundleHash)', () => {
    expect(() =>
      StrategyLlmOutputSchema.parse({ ...VALID_OUTPUT, bundleHash: 'sha256:deadbeef' })
    ).toThrow();
  });

  it('(b) throws on smuggled manifest-level field (bytes)', () => {
    expect(() =>
      StrategyLlmOutputSchema.parse({
        ...VALID_OUTPUT,
        manifest: { ...VALID_MANIFEST, bytes: new Uint8Array(0) },
      })
    ).toThrow();
  });

  it('(c) throws when manifest.kind is not "strategy"', () => {
    expect(() =>
      StrategyLlmOutputSchema.parse({
        ...VALID_OUTPUT,
        manifest: { ...VALID_MANIFEST, kind: 'overlay' },
      })
    ).toThrow();
  });

  it('(d) OpenAI-strict: throws when a nullable manifest field is missing (not undefined-safe)', () => {
    // author is nullable, not optional — must be explicitly present (even as null)
    const { author: _dropped, ...withoutAuthor } = VALID_MANIFEST;
    expect(() =>
      StrategyLlmOutputSchema.parse({ ...VALID_OUTPUT, manifest: withoutAuthor })
    ).toThrow();
  });

  it('(d) OpenAI-strict: throws when top-level notes is missing', () => {
    const { notes: _dropped, ...withoutNotes } = VALID_OUTPUT;
    expect(() => StrategyLlmOutputSchema.parse(withoutNotes)).toThrow();
  });

  it('(e) paramsSchema must be a JSON string, not a plain object', () => {
    expect(() =>
      StrategyLlmOutputSchema.parse({
        ...VALID_OUTPUT,
        manifest: { ...VALID_MANIFEST, paramsSchema: { type: 'object' } },
      })
    ).toThrow();
  });

  it('(f) hooks array with "init" parses OK (broadened enum)', () => {
    const parsed = StrategyLlmOutputSchema.parse({
      ...VALID_OUTPUT,
      manifest: { ...VALID_MANIFEST, hooks: ['init', 'onBarClose'] },
    });
    expect(parsed.manifest.hooks).toEqual(['init', 'onBarClose']);
  });
});

describe('llmToStrategyBuilderOutput', () => {
  it('(a) returns {source, manifestMeta} with no `kind` on manifestMeta', () => {
    const parsed = StrategyLlmOutputSchema.parse(VALID_OUTPUT);
    const output = llmToStrategyBuilderOutput(parsed);
    expect(output.source).toBe(VALID_OUTPUT.source);
    expect('kind' in output.manifestMeta).toBe(false);
    expect(output.manifestMeta.id).toBe('strat-001');
  });

  it('(a) strips null capabilities — only truthy booleans remain', () => {
    const parsed = StrategyLlmOutputSchema.parse(VALID_OUTPUT);
    const { manifestMeta } = llmToStrategyBuilderOutput(parsed);
    expect((manifestMeta.capabilities as Record<string, unknown>)['platformSdk']).toBe(true);
    expect('exchangeDirect' in manifestMeta.capabilities).toBe(false);
  });

  it('(a) strips null dataNeeds — only truthy booleans remain', () => {
    const parsed = StrategyLlmOutputSchema.parse(VALID_OUTPUT);
    const { manifestMeta } = llmToStrategyBuilderOutput(parsed);
    expect((manifestMeta.dataNeeds as Record<string, unknown>)['closedCandlesUpToCurrent']).toBe(true);
    expect('asOfIndicators' in manifestMeta.dataNeeds).toBe(false);
  });

  it('(a) null optional fields are absent from manifestMeta', () => {
    const parsed = StrategyLlmOutputSchema.parse(VALID_OUTPUT);
    const { manifestMeta } = llmToStrategyBuilderOutput(parsed);
    expect('params' in manifestMeta).toBe(false);
    expect('targetStrategyRef' in manifestMeta).toBe(false);
  });

  it('(b) paramsSchema JSON string → manifestMeta.paramsSchema is the parsed object', () => {
    const parsed = StrategyLlmOutputSchema.parse(VALID_OUTPUT);
    const { manifestMeta } = llmToStrategyBuilderOutput(parsed);
    expect(manifestMeta.paramsSchema).toEqual({ type: 'object', additionalProperties: false });
  });

  it('(d) round-trip: manifestMeta feeds createModuleManifest({kind:"strategy"}) successfully', () => {
    const parsed = StrategyLlmOutputSchema.parse(VALID_OUTPUT);
    const { manifestMeta } = llmToStrategyBuilderOutput(parsed);
    const bundleManifest = createModuleManifest({ kind: 'strategy', ...manifestMeta });
    expect(bundleManifest.kind).toBe('strategy');
    expect(bundleManifest.id).toBe('strat-001');
    expect(bundleManifest.name).toBe('Test Strategy');
  });
});
