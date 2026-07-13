import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, rm, access } from 'node:fs/promises';
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
    // Publish atomically (P1-21). The file is named by its content hash, so an existing blob already
    // holds the exact bytes — skip it (idempotent, and never truncates a file a reader may hold open).
    // Otherwise write to a unique temp then rename() into place: a concurrent reader on the shared
    // .artifacts CAS sees either the old file or the complete new one, never a half-written blob.
    if (!(await this.exists(filePath))) {
      const tmp = join(this.baseDir, `.${hex}.${randomUUID()}.tmp`);
      await writeFile(tmp, buf);
      try {
        await rename(tmp, filePath);
      } catch (err) {
        await rm(tmp, { force: true });
        // A concurrent writer may have created filePath between our exists() check and the rename;
        // its bytes are identical (same hash), so tolerate that and only surface a genuine failure.
        if (!(await this.exists(filePath))) throw err;
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
  //     get() into an arbitrary-filesystem read.
  //  2. hash-verify — recompute sha256 and compare to ref.content_hash, so a blob swapped in place
  //     under the same content-hash name (TOCTOU on the shared .artifacts CAS) is rejected, not served.
  async get(ref: ArtifactRef): Promise<Buffer> {
    let filePath: string;
    try {
      filePath = fileURLToPath(new URL(ref.uri));
    } catch {
      throw new Error(`artifact uri is not a readable file:// path: ${ref.uri}`);
    }
    const resolved = resolve(filePath);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + sep)) {
      throw new Error(`artifact uri escapes baseDir (containment violation): ${ref.uri}`);
    }
    const buf = await readFile(resolved);
    const actual = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
    if (actual !== ref.content_hash) {
      throw new Error(`artifact content_hash mismatch (integrity violation) for ${ref.uri}: expected ${ref.content_hash}, got ${actual}`);
    }
    return buf;
  }

  resolveUri(ref: ArtifactRef): string {
    return ref.uri;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }
}
