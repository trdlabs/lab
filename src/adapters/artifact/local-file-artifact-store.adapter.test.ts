import { describe, it, expect, afterEach } from 'vitest';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalFileArtifactStore } from './local-file-artifact-store.adapter.ts';

const DIR = '.artifacts-test';
const OUTSIDE = resolve('.artifacts-test-outside-secret');

describe('LocalFileArtifactStore', () => {
  afterEach(async () => {
    await rm(DIR, { recursive: true, force: true });
    await rm(OUTSIDE, { force: true });
  });

  it('stores content and returns a content-addressable ref', async () => {
    const store = new LocalFileArtifactStore(DIR);
    const ref = await store.put('hello', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    expect(ref.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.size_bytes).toBe(5);
    expect(ref.uri.startsWith('file://')).toBe(true);
    expect((await readFile(new URL(ref.uri))).toString()).toBe('hello');
  });

  it('is content-addressable: identical content => identical hash', async () => {
    const store = new LocalFileArtifactStore(DIR);
    const a = await store.put('same', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    const b = await store.put('same', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    expect(a.content_hash).toBe(b.content_hash);
    expect((await store.get(a)).toString()).toBe('same');
  });

  it('get() rejects a ref whose uri resolves outside baseDir (path traversal)', async () => {
    // P1-20: a forged ref must not turn get() into an arbitrary-file read.
    const store = new LocalFileArtifactStore(DIR);
    await writeFile(OUTSIDE, 'TOP SECRET');
    const ref = { ...(await store.put('x', { kind: 'logs', mime_type: 'text/plain', producer: 'test' })), uri: pathToFileURL(OUTSIDE).href };
    await expect(store.get(ref)).rejects.toThrow(/baseDir|outside|contain/i);
  });

  it('get() rejects when on-disk bytes no longer match content_hash (tamper / TOCTOU)', async () => {
    // P1-20: bundleHash is self-checked inside the artifact, so a swapped blob under the same
    // content-hash name would otherwise pass silently. get() must re-verify sha256 against the ref.
    const store = new LocalFileArtifactStore(DIR);
    const ref = await store.put('honest', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    await writeFile(new URL(ref.uri), 'EVIL');
    await expect(store.get(ref)).rejects.toThrow(/hash|mismatch|integrity/i);
  });
});
