import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
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
    await writeFile(filePath, buf);
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
}
