// src/ports/embedding.port.ts

export interface EmbeddingPort {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
}
