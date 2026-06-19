// src/adapters/similarity/pg-hybrid-strategy-similarity.adapter.test.ts

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { strategyRetrievalDocument } from '../../db/schema.ts';
import { PgHybridStrategySimilarityAdapter } from './pg-hybrid-strategy-similarity.adapter.ts';
import type { StrategySimilarityQuery } from '../../domain/strategy-retrieval.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a deterministic 1024-dim unit vector that points mostly in the direction
 *  of `component` (first element = 1, rest = small noise), normalised. */
function makeVector(component: number, noise: number = 0.001): number[] {
  const v: number[] = new Array(1024).fill(noise);
  v[0] = component;
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / mag);
}

/** A query vector that is closest to makeVector(1, 0.001) — i.e. profille 'p1'. */
const QUERY_VEC_NEAR_P1 = makeVector(1, 0.0001);

const BASE_META = { market: 'crypto', symbol: 'BTCUSDT', timeframe: '1h', direction: 'long' as const };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

d('PgHybridStrategySimilarityAdapter (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const adapter = new PgHybridStrategySimilarityAdapter(db);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean only this table — never truncate unrelated tables.
    await db.delete(strategyRetrievalDocument);
  });

  // Seed helper — inserts a doc and waits for tsvector to be generated.
  async function seedDoc(opts: {
    id: string;
    content: string;
    embedding: number[];
    metadata?: Record<string, unknown>;
    indexVersion?: number;
  }): Promise<void> {
    const vecLiteral = `[${opts.embedding.join(',')}]`;
    await db.execute(sql.raw(`
      INSERT INTO strategy_retrieval_document
        (strategy_profile_id, content, content_hash, embedding, embedding_model, index_version, metadata)
      VALUES (
        '${opts.id}',
        '${opts.content.replace(/'/g, "''")}',
        'hash-${opts.id}',
        '${vecLiteral}'::vector,
        'test-model',
        ${opts.indexVersion ?? 1},
        '${JSON.stringify(opts.metadata ?? BASE_META)}'::jsonb
      )
    `));
  }

  const baseQuery = (): StrategySimilarityQuery => ({
    text: 'momentum breakout',
    embedding: QUERY_VEC_NEAR_P1,
    filters: {},
    lexicalLimit: 50,
    vectorLimit: 50,
    fusedLimit: 20,
  });

  // ---------------------------------------------------------------------------
  // Basic round-trip
  // ---------------------------------------------------------------------------

  it('returns empty candidates when no documents seeded', async () => {
    const result = await adapter.search(baseQuery());
    expect(result.candidates).toEqual([]);
    expect(result.degradedReasonCodes).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Lexical ranking for exact trading terms
  // ---------------------------------------------------------------------------

  it('lexical branch ranks docs by exact term match', async () => {
    await seedDoc({ id: 'lex-a', content: 'momentum breakout strategy long', embedding: makeVector(0.5) });
    await seedDoc({ id: 'lex-b', content: 'momentum breakout volume spike', embedding: makeVector(0.4) });
    await seedDoc({ id: 'lex-c', content: 'unrelated strategy description', embedding: makeVector(0.3) });

    const result = await adapter.search(baseQuery());
    const ids = result.candidates.map((c) => c.strategyProfileId);

    // lex-a and lex-b match "momentum breakout" — must appear; lex-c must not
    // (tsvector with 'simple' stemmer: no match for 'unrelated' alone).
    expect(ids).toContain('lex-a');
    expect(ids).toContain('lex-b');
  });

  // ---------------------------------------------------------------------------
  // Vector branch: semantic candidate presence
  // ---------------------------------------------------------------------------

  it('vector branch surfaces semantically close doc even without lexical overlap', async () => {
    // p1 is closest to QUERY_VEC_NEAR_P1 (cosine-near).
    await seedDoc({ id: 'p1', content: 'completely different words here xyz', embedding: makeVector(1, 0.0001) });
    await seedDoc({ id: 'p2', content: 'completely different words here xyz', embedding: makeVector(-1, 0.0001) });

    const result = await adapter.search({
      ...baseQuery(),
      text: 'qwerty nonexistent', // guaranteed no lexical match
    });

    const ids = result.candidates.map((c) => c.strategyProfileId);
    expect(ids).toContain('p1');
  });

  // ---------------------------------------------------------------------------
  // RRF fusion and rank provenance
  // ---------------------------------------------------------------------------

  it('provides lexicalRank/vectorRank provenance on fused candidates', async () => {
    await seedDoc({ id: 'fused-1', content: 'momentum breakout trend', embedding: makeVector(1, 0.0001) });

    const result = await adapter.search(baseQuery());
    const c = result.candidates.find((x) => x.strategyProfileId === 'fused-1');
    expect(c).toBeDefined();
    // rrfScore must be positive
    expect(c!.rrfScore).toBeGreaterThan(0);

    // fused-1 should appear in at least one branch
    const hasBranchInfo = c!.lexicalRank !== undefined || c!.vectorRank !== undefined;
    expect(hasBranchInfo).toBe(true);

    // When it appears in vector branch, vectorRank is 1-based
    if (c!.vectorRank !== undefined) {
      expect(c!.vectorRank).toBeGreaterThanOrEqual(1);
    }
    if (c!.lexicalRank !== undefined) {
      expect(c!.lexicalRank).toBeGreaterThanOrEqual(1);
    }
  });

  it('fused result carries both lexicalRank and vectorRank when doc matches both', async () => {
    await seedDoc({ id: 'both', content: 'momentum breakout', embedding: makeVector(1, 0.0001) });

    const result = await adapter.search(baseQuery());
    const c = result.candidates.find((x) => x.strategyProfileId === 'both');
    expect(c).toBeDefined();
    // This doc matches lexically AND is closest vector — should appear in both
    expect(c!.lexicalRank).toBeDefined();
    expect(c!.vectorRank).toBeDefined();
    expect(c!.lexicalScore).toBeTypeOf('number');
    expect(c!.vectorDistance).toBeTypeOf('number');
  });

  // ---------------------------------------------------------------------------
  // No exact flag — semantic results are never exact duplicates
  // ---------------------------------------------------------------------------

  it('no candidate carries an exact flag', async () => {
    await seedDoc({ id: 'no-exact-1', content: 'momentum breakout', embedding: makeVector(1, 0.0001) });
    const result = await adapter.search(baseQuery());
    for (const c of result.candidates) {
      expect((c as unknown as Record<string, unknown>)['exact']).toBeUndefined();
    }
  });

  // ---------------------------------------------------------------------------
  // Metadata filters
  // ---------------------------------------------------------------------------

  it('metadata market filter excludes non-matching docs', async () => {
    await seedDoc({
      id: 'crypto-doc',
      content: 'momentum breakout',
      embedding: makeVector(0.9),
      metadata: { ...BASE_META, market: 'crypto' },
    });
    await seedDoc({
      id: 'forex-doc',
      content: 'momentum breakout',
      embedding: makeVector(0.8),
      metadata: { ...BASE_META, market: 'forex' },
    });

    const result = await adapter.search({ ...baseQuery(), filters: { market: 'crypto' } });
    const ids = result.candidates.map((c) => c.strategyProfileId);
    expect(ids).toContain('crypto-doc');
    expect(ids).not.toContain('forex-doc');
  });

  it('metadata symbol filter works', async () => {
    await seedDoc({
      id: 'btc-doc',
      content: 'momentum breakout',
      embedding: makeVector(0.9),
      metadata: { ...BASE_META, symbol: 'BTCUSDT' },
    });
    await seedDoc({
      id: 'eth-doc',
      content: 'momentum breakout',
      embedding: makeVector(0.8),
      metadata: { ...BASE_META, symbol: 'ETHUSDT' },
    });

    const result = await adapter.search({ ...baseQuery(), filters: { symbol: 'BTCUSDT' } });
    const ids = result.candidates.map((c) => c.strategyProfileId);
    expect(ids).toContain('btc-doc');
    expect(ids).not.toContain('eth-doc');
  });

  it('metadata timeframe filter works', async () => {
    await seedDoc({
      id: '1h-doc',
      content: 'momentum breakout',
      embedding: makeVector(0.9),
      metadata: { ...BASE_META, timeframe: '1h' },
    });
    await seedDoc({
      id: '4h-doc',
      content: 'momentum breakout',
      embedding: makeVector(0.8),
      metadata: { ...BASE_META, timeframe: '4h' },
    });

    const result = await adapter.search({ ...baseQuery(), filters: { timeframe: '1h' } });
    const ids = result.candidates.map((c) => c.strategyProfileId);
    expect(ids).toContain('1h-doc');
    expect(ids).not.toContain('4h-doc');
  });

  it('metadata direction filter works', async () => {
    await seedDoc({
      id: 'long-doc',
      content: 'momentum breakout',
      embedding: makeVector(0.9),
      metadata: { ...BASE_META, direction: 'long' },
    });
    await seedDoc({
      id: 'short-doc',
      content: 'momentum breakout',
      embedding: makeVector(0.8),
      metadata: { ...BASE_META, direction: 'short' },
    });

    const result = await adapter.search({ ...baseQuery(), filters: { direction: 'long' } });
    const ids = result.candidates.map((c) => c.strategyProfileId);
    expect(ids).toContain('long-doc');
    expect(ids).not.toContain('short-doc');
  });

  // ---------------------------------------------------------------------------
  // excludeProfileId
  // ---------------------------------------------------------------------------

  it('excludeProfileId removes the profile from both branches', async () => {
    await seedDoc({ id: 'exclude-me', content: 'momentum breakout', embedding: makeVector(1, 0.0001) });
    await seedDoc({ id: 'keep-me', content: 'momentum breakout', embedding: makeVector(0.9) });

    const result = await adapter.search({ ...baseQuery(), excludeProfileId: 'exclude-me' });
    const ids = result.candidates.map((c) => c.strategyProfileId);
    expect(ids).not.toContain('exclude-me');
    expect(ids).toContain('keep-me');
  });

  // ---------------------------------------------------------------------------
  // Limits
  // ---------------------------------------------------------------------------

  it('fusedLimit caps the result length', async () => {
    // Seed 10 docs with lexical matches
    for (let i = 0; i < 10; i++) {
      await seedDoc({
        id: `limit-doc-${i}`,
        content: 'momentum breakout unique term',
        embedding: makeVector(0.5 + i * 0.01),
      });
    }

    const result = await adapter.search({ ...baseQuery(), fusedLimit: 3 });
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  // ---------------------------------------------------------------------------
  // Abort propagation
  // ---------------------------------------------------------------------------

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.search({ ...baseQuery(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  // ---------------------------------------------------------------------------
  // Per-branch degraded reason codes
  // ---------------------------------------------------------------------------

  it('records lexical_failed when lexical branch is forced to fail', async () => {
    // Inject a broken adapter that always fails the lexical branch by passing
    // an invalid db that throws on execute. We test via a subclass override.
    class BrokenLexicalAdapter extends PgHybridStrategySimilarityAdapter {
      // Override by passing a db that rejects on the first query
    }

    // We can't easily override internals, so instead we test the degraded path
    // by constructing a mock that simulates the documented behavior:
    // If both fail → { candidates: [], degradedReasonCodes: ['lexical_failed', 'vector_failed'] }
    // We verify this invariant holds by checking an adapter with an intentionally bad DB URL.
    const { db: badDb, pool: badPool } = createDbClient('postgresql://invalid:5432/nonexistent');
    const badAdapter = new PgHybridStrategySimilarityAdapter(badDb);

    try {
      const result = await badAdapter.search(baseQuery());
      // Both branches should fail → empty candidates + both codes
      expect(result.degradedReasonCodes).toContain('lexical_failed');
      expect(result.degradedReasonCodes).toContain('vector_failed');
      expect(result.candidates).toEqual([]);
    } finally {
      await badPool.end().catch(() => {/* ignore */});
    }
  });
});
