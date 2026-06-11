// src/adapters/builder/fake-builder.test.ts
import { describe, it, expect } from 'vitest';
import { FakeBuilder } from './fake-builder.ts';
import { BuilderOutputSchema } from '../../ports/builder.port.ts';
import { assembleBundle, SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { validateBundle } from '../../validation/build-validator.ts';
import { LAB_FEATURE_CATALOG } from '../../domain/hypothesis-rules.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when oi trend persists',
    targetBehavior: 'filter entries', ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend persists for 2 bars', action: 'skip_entry', params: { bars: 2 } }] },
    requiredFeatures: ['oi', 'funding'], validationPlan: 'backtest 90d',
    expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['no improvement'],
    confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never,
    issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now,
  };
}
function profile(): StrategyProfile {
  return { id: 'p1', requiredMarketFeatures: ['oi', 'funding'], direction: 'long' } as unknown as StrategyProfile;
}

describe('FakeBuilder', () => {
  it('produces a strict-schema-valid BuilderOutput', async () => {
    const out = await new FakeBuilder().build({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'doc' });
    expect(BuilderOutputSchema.safeParse(out).success).toBe(true);
  });

  it('produces a bundle that passes the Build Validator', async () => {
    const out = await new FakeBuilder().build({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'doc' });
    const bundle = assembleBundle(out.manifest, out.files);
    const allowed = { allowedImports: new Set<string>(), allowedCapabilities: new Set<string>([...LAB_FEATURE_CATALOG, 'oi', 'funding']) };
    const r = validateBundle(bundle, allowed);
    expect(r.status).toBe('built');
    expect(out.manifest.sdkContractVersion).toBe(SDK_CONTRACT_VERSION);
  });

  it('strict schema rejects an extra top-level key (no trusted LLM hash)', () => {
    const bad = { manifest: { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: [], sdkContractVersion: SDK_CONTRACT_VERSION }, files: {}, bundleHash: 'sha256:evil' };
    expect(BuilderOutputSchema.safeParse(bad).success).toBe(false);
  });
});
