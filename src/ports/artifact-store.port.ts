import type { ArtifactRef } from '../domain/types.ts';

export interface PutArtifactMeta {
  kind: string;
  mime_type: string;
  producer: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactStorePort {
  put(content: Buffer | string, meta: PutArtifactMeta): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Buffer>;
  resolveUri(ref: ArtifactRef): string;
}
