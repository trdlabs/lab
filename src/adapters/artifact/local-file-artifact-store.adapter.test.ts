import { describe, it, expect, afterEach, vi } from 'vitest';
import { rm, readFile, writeFile, utimes, stat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fault-injection seam for the "failed publication leaves no temp" test: when the flag is set, the
// next writeFile creates a partial file at its target and then rejects — the one failure mode real
// fs can't produce deterministically. Everything else delegates to the real module.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  const { writeFileSync } = await import('node:fs');
  return {
    ...actual,
    writeFile: (async (p: unknown, data: unknown) => {
      if ((globalThis as Record<string, unknown>).__casFailNextWrite) {
        (globalThis as Record<string, unknown>).__casFailNextWrite = false;
        writeFileSync(p as string, 'partial'); // orphan a partial temp...
        throw new Error('disk full'); // ...then fail
      }
      return actual.writeFile(p as never, data as never);
    }) as typeof actual.writeFile,
  };
});
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

  it('put() is idempotent — an already-stored blob is not rewritten (skip-if-exists)', async () => {
    // P1-21: content is addressed by hash, so an existing blob already holds the exact bytes.
    // Re-writing it in place (naive writeFile truncates then writes) both wastes IO and opens a
    // window where a concurrent reader sees a truncated file. A second put must leave it untouched.
    const store = new LocalFileArtifactStore(DIR);
    const ref = await store.put('idem', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    const p = new URL(ref.uri);
    const pinned = new Date('2020-01-01T00:00:00.000Z');
    await utimes(p, pinned, pinned); // pin mtime to the past
    await store.put('idem', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    const st = await stat(p);
    expect(st.mtime.getTime()).toBe(pinned.getTime()); // untouched => skipped
  });

  it('put() leaves no temporary/partial files in baseDir (atomic temp+rename)', async () => {
    // P1-21: the blob must be published via a rename, and any temp must be gone afterward — a
    // concurrent reader must only ever see the final, complete content-hash file.
    const store = new LocalFileArtifactStore(DIR);
    await store.put('atomic', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    const entries = await readdir(DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('put() self-heals a tampered blob: re-putting the original bytes restores it (skip must verify hash, not just existence)', async () => {
    // P1-21 review: skip-if-exists must not trust a file by existence alone — that contradicts P1-20.
    // If a blob was tampered, re-putting the original must atomically replace the corrupt bytes so
    // get() succeeds again, rather than silently returning a ref to a file get() will keep rejecting.
    const store = new LocalFileArtifactStore(DIR);
    const ref = await store.put('healme', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    await writeFile(new URL(ref.uri), 'EVIL'); // corrupt the on-disk blob under its hash name
    await expect(store.get(ref)).rejects.toThrow(/hash|mismatch|integrity/i); // P1-20 rejects it now
    const ref2 = await store.put('healme', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    expect(ref2.content_hash).toBe(ref.content_hash);
    expect((await store.get(ref2)).toString()).toBe('healme'); // restored
  });

  it('a failed publication leaves no .tmp behind (write+rename share a finally cleanup)', async () => {
    // P1-21 review: the temp write must be inside the try/finally, else a partial temp from a failed
    // writeFile is orphaned in the shared CAS dir.
    const store = new LocalFileArtifactStore(DIR);
    (globalThis as Record<string, unknown>).__casFailNextWrite = true;
    try {
      await expect(store.put('boom', { kind: 'logs', mime_type: 'text/plain', producer: 'test' })).rejects.toThrow('disk full');
    } finally {
      (globalThis as Record<string, unknown>).__casFailNextWrite = false;
    }
    const entries = await readdir(DIR);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });

  it('concurrent puts of identical content settle to exactly one intact file (benign race)', async () => {
    // P1-21: two writers racing the exists()->rename window must not throw or leave temp litter —
    // their bytes are identical, so the loser's rename simply overwrites atomically.
    const store = new LocalFileArtifactStore(DIR);
    const refs = await Promise.all(
      Array.from({ length: 8 }, () => store.put('raced', { kind: 'logs', mime_type: 'text/plain', producer: 'test' })),
    );
    expect(new Set(refs.map((r) => r.content_hash)).size).toBe(1);
    const entries = await readdir(DIR);
    expect(entries).toHaveLength(1);
    expect((await store.get(refs[0]!)).toString()).toBe('raced');
  });
});
