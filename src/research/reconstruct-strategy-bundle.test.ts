import { describe, it, expect } from 'vitest';
import { InMemoryArtifactStore } from '../adapters/artifact/in-memory-artifact-store.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import { FakeStrategyBuilder } from '../adapters/builder/fake-strategy-builder.ts';
import { reconstructStrategyBundle } from './reconstruct-strategy-bundle.ts';

/**
 * Build a real AssembledStrategyBundle via the same path production code uses
 * (FakeStrategyBuilder.build() → assembleStrategyBundle), so bundleHash is a genuine
 * hash of real bundled bytes rather than a hand-authored constant.
 */
async function makeTestStrategyBundle(): Promise<AssembledStrategyBundle> {
  const builder = new FakeStrategyBuilder();
  const out = await builder.build({ spec: { description: 'test' }, authoringDoc: '' });
  return assembleStrategyBundle(out);
}

describe('reconstructStrategyBundle', () => {
  it('reconstructs a bundle byte-identical in hash to the persisted one', async () => {
    const store = new InMemoryArtifactStore();
    const bundle = await makeTestStrategyBundle();
    const ref = await store.put(
      JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
      { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
    );
    const got = await reconstructStrategyBundle(store, ref);
    expect(got.bundleHash).toBe(bundle.bundleHash);
  });

  it('fails fast when the stored hash does not match the reassembled bundle', async () => {
    const store = new InMemoryArtifactStore();
    const bundle = await makeTestStrategyBundle();
    const ref = await store.put(
      JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: 'sha256:corrupted' }),
      { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
    );
    await expect(reconstructStrategyBundle(store, ref)).rejects.toThrow(/hash mismatch/i);
  });

  it('fails with an actionable error on malformed artifact JSON', async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put('not json', { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' });
    await expect(reconstructStrategyBundle(store, ref)).rejects.toThrow(/strategy_bundle artifact/i);
  });
});
