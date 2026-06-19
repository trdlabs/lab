// src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.ts

import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { StrategySimilarityPort } from '../../ports/strategy-similarity.port.ts';
import type {
  StrategyCandidateSet,
  SimilarStrategyCandidate,
  StrategySimilarityQuery,
  StrategyRetrievalMetadata,
} from '../../domain/strategy-retrieval.ts';
import { reciprocalRankFusion } from './rrf.ts';

const EMBEDDING_DIM = 1024;

interface LexicalRow {
  strategy_profile_id: string;
  metadata: StrategyRetrievalMetadata;
  score: number;
}

interface VectorRow {
  strategy_profile_id: string;
  metadata: StrategyRetrievalMetadata;
  distance: number;
}

function buildMetadataConditions(
  filters: StrategySimilarityQuery['filters'],
): string[] {
  const conds: string[] = [];
  if (filters.market) {
    conds.push(`metadata->>'market' = '${escapeJsonValue(filters.market)}'`);
  }
  if (filters.symbol) {
    conds.push(`metadata->>'symbol' = '${escapeJsonValue(filters.symbol)}'`);
  }
  if (filters.timeframe) {
    conds.push(`metadata->>'timeframe' = '${escapeJsonValue(filters.timeframe)}'`);
  }
  if (filters.direction) {
    conds.push(`metadata->>'direction' = '${escapeJsonValue(filters.direction)}'`);
  }
  return conds;
}

/** Minimal escaping — values come from validated query filters, not user-supplied SQL. */
function escapeJsonValue(v: string): string {
  return v.replace(/'/g, "''");
}

function formatVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

function validateEmbedding(embedding: readonly number[]): void {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `pg-hybrid: embedding must be length ${EMBEDDING_DIM}, got ${embedding.length}`,
    );
  }
  for (const v of embedding) {
    if (!Number.isFinite(v)) {
      throw new Error('pg-hybrid: embedding contains non-finite value');
    }
  }
}

/**
 * PgHybridStrategySimilarityAdapter implements StrategySimilarityPort using
 * Postgres full-text search (tsvector) + pgvector cosine-distance, fused via RRF.
 *
 * Both branches run concurrently via Promise.allSettled. If a single branch
 * fails, its degraded reason code is recorded and the surviving branch is fused
 * alone. If both fail the result is empty with both reason codes set.
 */
export class PgHybridStrategySimilarityAdapter implements StrategySimilarityPort {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async search(query: StrategySimilarityQuery): Promise<StrategyCandidateSet> {
    if (query.signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    validateEmbedding(query.embedding);

    const lexicalLimit = query.lexicalLimit ?? 50;
    const vectorLimit = query.vectorLimit ?? 50;
    const fusedLimit = query.fusedLimit ?? 20;

    const metaConds = buildMetadataConditions(query.filters);
    const excludeCond = query.excludeProfileId
      ? `strategy_profile_id <> '${escapeJsonValue(query.excludeProfileId)}'`
      : null;

    const extraWhere = [...metaConds, ...(excludeCond ? [excludeCond] : [])];
    const extraClause = extraWhere.length > 0 ? `AND ${extraWhere.join(' AND ')}` : '';

    // --- Lexical branch ---
    const lexicalSql = sql.raw(`
      SELECT strategy_profile_id, metadata,
             ts_rank_cd(search_vector, plainto_tsquery('simple', ${sqlStringLiteral(query.text)})) AS score
      FROM strategy_retrieval_document
      WHERE search_vector @@ plainto_tsquery('simple', ${sqlStringLiteral(query.text)})
        ${extraClause}
      ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', ${sqlStringLiteral(query.text)})) DESC,
               strategy_profile_id ASC
      LIMIT ${lexicalLimit}
    `);

    // --- Vector branch ---
    const vecLiteral = `'${formatVectorLiteral(query.embedding)}'::vector`;
    const vectorSql = sql.raw(`
      SELECT strategy_profile_id, metadata,
             (embedding <=> ${vecLiteral}) AS distance
      FROM strategy_retrieval_document
      WHERE embedding IS NOT NULL
        ${extraClause}
      ORDER BY embedding <=> ${vecLiteral},
               strategy_profile_id ASC
      LIMIT ${vectorLimit}
    `);

    const abortCheck = (): boolean => query.signal?.aborted ?? false;

    const [lexicalResult, vectorResult] = await Promise.allSettled([
      abortCheck()
        ? Promise.reject(new DOMException('Aborted', 'AbortError'))
        : this.db.execute(lexicalSql),
      abortCheck()
        ? Promise.reject(new DOMException('Aborted', 'AbortError'))
        : this.db.execute(vectorSql),
    ]);

    if (query.signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    const degradedReasonCodes: string[] = [];

    const lexicalRows: LexicalRow[] =
      lexicalResult.status === 'fulfilled'
        ? (lexicalResult.value.rows as unknown as LexicalRow[])
        : (degradedReasonCodes.push('lexical_failed'), []);

    const vectorRows: VectorRow[] =
      vectorResult.status === 'fulfilled'
        ? (vectorResult.value.rows as unknown as VectorRow[])
        : (degradedReasonCodes.push('vector_failed'), []);

    if (degradedReasonCodes.length === 2) {
      return { candidates: [], degradedReasonCodes };
    }

    // Build rank lists for RRF (1-based positions).
    const lexicalEntries = lexicalRows.map((row, idx) => ({
      id: row.strategy_profile_id,
      rank: idx + 1,
    }));
    const vectorEntries = vectorRows.map((row, idx) => ({
      id: row.strategy_profile_id,
      rank: idx + 1,
    }));

    const fused = reciprocalRankFusion(
      { lexical: lexicalEntries, vector: vectorEntries },
      { k: 60, limit: fusedLimit },
    );

    // Build lookup maps from the raw rows.
    const lexicalMap = new Map<string, LexicalRow>(
      lexicalRows.map((r) => [r.strategy_profile_id, r]),
    );
    const vectorMap = new Map<string, VectorRow>(
      vectorRows.map((r) => [r.strategy_profile_id, r]),
    );

    const candidates: SimilarStrategyCandidate[] = fused.map((entry) => {
      const lexRow = lexicalMap.get(entry.id);
      const vecRow = vectorMap.get(entry.id);
      // Prefer metadata from vector row (always present) or lexical row.
      const metadata: StrategyRetrievalMetadata =
        (vecRow?.metadata ?? lexRow?.metadata) as StrategyRetrievalMetadata;

      const candidate: SimilarStrategyCandidate = {
        strategyProfileId: entry.id,
        rrfScore: entry.score,
        metadata,
      };

      if (entry.lexicalRank !== undefined) {
        candidate.lexicalRank = entry.lexicalRank;
        candidate.lexicalScore = lexRow?.score;
      }
      if (entry.vectorRank !== undefined) {
        candidate.vectorRank = entry.vectorRank;
        candidate.vectorDistance = vecRow?.distance;
      }

      return candidate;
    });

    return { candidates, degradedReasonCodes };
  }
}

/** Safely wrap a string as a SQL single-quoted literal (escaping single quotes). */
function sqlStringLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
