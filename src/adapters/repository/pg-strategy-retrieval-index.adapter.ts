import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { strategyRetrievalDocument } from '../../db/schema.ts';
import type { StrategyRetrievalDocument, StrategyRetrievalMetadata } from '../../domain/strategy-retrieval.ts';
import type { StrategyRetrievalIndexPort } from '../../ports/strategy-retrieval-index.port.ts';

export interface PgStrategyRetrievalIndexConfig {
  /** Embedding model whose vectors this adapter reads/writes (stale guard on read). */
  embeddingModel: string;
  /** Projection schema/index version this adapter reads/writes (stale guard on read). */
  indexVersion: number;
}

const EMBEDDING_DIMENSIONS = 1024;

/**
 * Validate an embedding BEFORE any SQL: must be exactly EMBEDDING_DIMENSIONS long and
 * contain only finite numbers. Returns a fresh mutable array suitable for the pg driver
 * (the domain type is `readonly number[]`). Never logs the embedding values.
 */
function toValidatedEmbedding(embedding: readonly number[], profileId: string): number[] {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `strategy_retrieval_document embedding for ${profileId} must have ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`,
    );
  }
  const out = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    const v = embedding[i]!;
    if (!Number.isFinite(v)) {
      throw new Error(
        `strategy_retrieval_document embedding for ${profileId} contains a non-finite value at index ${i}`,
      );
    }
    out[i] = v;
  }
  return out;
}

export class PgStrategyRetrievalIndexAdapter implements StrategyRetrievalIndexPort {
  private readonly db: Db;
  private readonly embeddingModel: string;
  private readonly indexVersion: number;

  constructor(db: Db, config: PgStrategyRetrievalIndexConfig) {
    this.db = db;
    this.embeddingModel = config.embeddingModel;
    this.indexVersion = config.indexVersion;
  }

  async upsert(document: StrategyRetrievalDocument): Promise<void> {
    // Validate the vector before touching SQL so a bad embedding never reaches the DB.
    const embedding = toValidatedEmbedding(document.embedding, document.strategyProfileId);

    const values = {
      strategyProfileId: document.strategyProfileId,
      content: document.content,
      contentHash: document.contentHash,
      embedding,
      embeddingModel: document.embeddingModel,
      indexVersion: document.indexVersion,
      metadata: document.metadata,
      indexedAt: new Date(document.indexedAt),
    };

    await this.db
      .insert(strategyRetrievalDocument)
      .values(values)
      .onConflictDoUpdate({
        target: strategyRetrievalDocument.strategyProfileId,
        set: {
          content: values.content,
          contentHash: values.contentHash,
          embedding: values.embedding,
          embeddingModel: values.embeddingModel,
          indexVersion: values.indexVersion,
          metadata: values.metadata,
          indexedAt: values.indexedAt,
        },
      });
    // search_vector is a STORED generated column — Postgres recomputes it from `content`.
  }

  async findByProfileId(profileId: string): Promise<StrategyRetrievalDocument | null> {
    // Exclude stale projections: only rows matching THIS adapter's configured
    // embedding_model + index_version are visible. A row written under a different
    // model/version is treated as absent (null) until reindexed.
    const rows = await this.db
      .select({
        strategyProfileId: strategyRetrievalDocument.strategyProfileId,
        content: strategyRetrievalDocument.content,
        contentHash: strategyRetrievalDocument.contentHash,
        embedding: strategyRetrievalDocument.embedding,
        embeddingModel: strategyRetrievalDocument.embeddingModel,
        indexVersion: strategyRetrievalDocument.indexVersion,
        metadata: strategyRetrievalDocument.metadata,
        indexedAt: strategyRetrievalDocument.indexedAt,
      })
      .from(strategyRetrievalDocument)
      .where(and(
        eq(strategyRetrievalDocument.strategyProfileId, profileId),
        eq(strategyRetrievalDocument.embeddingModel, this.embeddingModel),
        eq(strategyRetrievalDocument.indexVersion, this.indexVersion),
      ))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      strategyProfileId: row.strategyProfileId,
      content: row.content,
      contentHash: row.contentHash,
      embedding: row.embedding ?? [],
      embeddingModel: row.embeddingModel,
      indexVersion: row.indexVersion,
      metadata: row.metadata as StrategyRetrievalMetadata,
      indexedAt: row.indexedAt.toISOString(),
    };
  }

  async delete(profileId: string): Promise<void> {
    await this.db
      .delete(strategyRetrievalDocument)
      .where(eq(strategyRetrievalDocument.strategyProfileId, profileId));
  }
}
