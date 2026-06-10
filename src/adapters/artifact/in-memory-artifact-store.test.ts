import { describe, it, expect } from 'vitest';
import { InMemoryArtifactStore } from './in-memory-artifact-store.ts';

describe('InMemoryArtifactStore', () => {
  it('stores content and round-trips via get; content-addressable', async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put('hello', { kind: 'strategy_source', mime_type: 'text/plain', producer: 'test' });
    expect(ref.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.uri.startsWith('memory://')).toBe(true);
    expect((await store.get(ref)).toString()).toBe('hello');
    const ref2 = await store.put('hello', { kind: 'strategy_source', mime_type: 'text/plain', producer: 'test' });
    expect(ref2.content_hash).toBe(ref.content_hash);
  });
  it('throws on get of a missing artifact', async () => {
    const store = new InMemoryArtifactStore();
    await expect(store.get({
      artifact_id: 'sha256:zz', uri: 'memory://zz', content_hash: 'sha256:zz', kind: 'k',
      size_bytes: 0, mime_type: 'text/plain', created_at: '2026-06-11T00:00:00Z', producer: 't', metadata: {},
    })).rejects.toThrow(/not found/);
  });
});
