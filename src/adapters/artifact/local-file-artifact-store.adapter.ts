import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, rm, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ArtifactStorePort, PutArtifactMeta } from '../../ports/artifact-store.port.ts';

export class LocalFileArtifactStore implements ArtifactStorePort {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  // Only the bytes are written to disk (file named by content hash). The metadata
  // (kind/producer/created_at/metadata) is NOT persisted here — callers are
  // responsible for persisting the returned ArtifactRef (e.g. the artifact_ref table).
  async put(content: Buffer | string, meta: PutArtifactMeta): Promise<ArtifactRef> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hex = createHash('sha256').update(buf).digest('hex');
    const contentHash = `sha256:${hex}`;
    await mkdir(this.baseDir, { recursive: true });
    const filePath = join(this.baseDir, hex);
    // Publish atomically and self-heal (P1-21). Skip ONLY when an existing file's bytes actually hash
    // to `hex` — trusting existence alone would contradict get()'s P1-20 hash-verify: a tampered blob
    // under the content-hash name would be left corrupt forever, with get() rejecting it every time.
    // Otherwise write to a unique temp then rename() into place (a reader on the shared .artifacts CAS
    // sees either the old file or the complete new one, never a half-written blob); rename() overwrites
    // atomically on POSIX, so the last of two racing writers of identical bytes wins. The temp write and
    // rename share one try/finally so a partial temp from a failed writeFile is always cleaned up.
    if (!(await this.hasValidBlob(filePath, hex))) {
      const tmp = join(this.baseDir, `.${hex}.${randomUUID()}.tmp`);
      try {
        await writeFile(tmp, buf);
        await rename(tmp, filePath);
      } finally {
        // Best-effort cleanup — a failing rm must never mask the primary write/rename error.
        try { await rm(tmp, { force: true }); } catch { /* ignore */ }
      }
    }
    return {
      artifact_id: contentHash,
      uri: pathToFileURL(filePath).href,
      content_hash: contentHash,
      kind: meta.kind,
      size_bytes: buf.byteLength,
      mime_type: meta.mime_type,
      created_at: new Date().toISOString(),
      producer: meta.producer,
      metadata: meta.metadata ?? {},
    };
  }

  // Reads must not trust a stored ref blindly. Two guards (P1-20):
  //  1. containment — the resolved file:// path must live under baseDir, so a forged ref can't turn
  //     get() into an arbitrary-filesystem read. Checked both lexically (cheap, catches ../ escapes
  //     on absent paths) AND via realpath (resolves symlinks, so a link inside baseDir can't point out).
  //  2. hash-verify — recompute sha256 and compare to ref.content_hash, so a blob swapped in place
  //     under the same content-hash name (TOCTOU on the shared .artifacts CAS) is rejected, not served.
  async get(ref: ArtifactRef): Promise<Buffer> {
    let filePath: string;
    try {
      filePath = fileURLToPath(new URL(ref.uri));
    } catch {
      throw new Error(`artifact uri is not a readable file:// path: ${ref.uri}`);
    }
    const lexical = resolve(filePath);
    if (lexical !== this.baseDir && !lexical.startsWith(this.baseDir + sep)) {
      throw new Error(`artifact uri escapes baseDir (containment violation): ${ref.uri}`);
    }
    // Symlink containment: resolve links on BOTH the target and baseDir, then require containment.
    // Fail CLOSED — get() needs an existing file anyway, so a realpath error (missing file, permission,
    // race) must reject rather than fall back to the lexical path and read something the symlink check
    // never vetted.
    let real: string;
    let realBase: string;
    try {
      real = await realpath(lexical);
      realBase = await realpath(this.baseDir);
    } catch {
      throw new Error(`artifact path could not be resolved for containment check: ${ref.uri}`);
    }
    if (real !== realBase && !real.startsWith(realBase + sep)) {
      throw new Error(`artifact uri resolves outside baseDir via symlink (containment violation): ${ref.uri}`);
    }
    const buf = await readFile(real);
    const actual = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
    if (actual !== ref.content_hash) {
      throw new Error(`artifact content_hash mismatch (integrity violation) for ${ref.uri}: expected ${ref.content_hash}, got ${actual}`);
    }
    return buf;
  }

  resolveUri(ref: ArtifactRef): string {
    return ref.uri;
  }

  // True only when `filePath` exists AND its bytes hash to `hex` — an absent, unreadable, or
  // tampered blob returns false so put() (re)writes correct bytes. Mirrors get()'s integrity check.
  private async hasValidBlob(filePath: string, hex: string): Promise<boolean> {
    let buf: Buffer;
    try {
      buf = await readFile(filePath);
    } catch {
      return false;
    }
    return createHash('sha256').update(buf).digest('hex') === hex;
  }
}
