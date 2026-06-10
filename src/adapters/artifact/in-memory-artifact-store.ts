import { createHash } from 'node:crypto';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ArtifactStorePort, PutArtifactMeta } from '../../ports/artifact-store.port.ts';

export class InMemoryArtifactStore implements ArtifactStorePort {
  private readonly byHash = new Map<string, Buffer>();

  async put(content: Buffer | string, meta: PutArtifactMeta): Promise<ArtifactRef> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hex = createHash('sha256').update(buf).digest('hex');
    const contentHash = `sha256:${hex}`;
    this.byHash.set(contentHash, buf);
    return {
      artifact_id: contentHash,
      uri: `memory://${hex}`,
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
    const buf = this.byHash.get(ref.content_hash);
    if (!buf) throw new Error(`artifact not found: ${ref.content_hash}`);
    return buf;
  }

  resolveUri(ref: ArtifactRef): string {
    return ref.uri;
  }
}
