import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ArtifactStorePort, PutArtifactMeta } from '../../ports/artifact-store.port.ts';

export class LocalFileArtifactStore implements ArtifactStorePort {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

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

  async get(ref: ArtifactRef): Promise<Buffer> {
    return readFile(new URL(ref.uri));
  }

  resolveUri(ref: ArtifactRef): string {
    return ref.uri;
  }
}
