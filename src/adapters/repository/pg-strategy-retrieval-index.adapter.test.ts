import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { PgStrategyRetrievalIndexAdapter } from './pg-strategy-retrieval-index.adapter.ts';
import { strategyRetrievalDocument } from '../../db/schema.ts';
import type { StrategyRetrievalDocument } from '../../domain/strategy-retrieval.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const MODEL = 'baai/bge-m3';
const VERSION = 1;
const DIM = 1024;

// Deterministic 1024-dim unit-ish vector.
function vec(seed: number, dim = DIM): number[] {
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = Math.sin((seed + 1) * (i + 1) * 0.001);
  }
  return out;
}

const doc = (over: Partial<StrategyRetrievalDocument> = {}): StrategyRetrievalDocument => ({
  strategyProfileId: 'sp-1',
  content: 'long after a flush on the 1m timeframe',
  contentHash: 'sha256:content-1',
  embedding: vec(1),
  embeddingModel: MODEL,
  indexVersion: VERSION,
  metadata: { market: 'crypto', symbol: 'BTCUSDT', timeframe: '1m', direction: 'long', label: 'Long after flush' },
  indexedAt: '2026-06-18T12:00:00.000Z',
  ...over,
});

d('PgStrategyRetrievalIndexAdapter (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const adapter = new PgStrategyRetrievalIndexAdapter(db, { embeddingModel: MODEL, indexVersion: VERSION });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    // Isolation: clean ONLY this suite's table. Other DB suites own their own tables;
    // no FK links them, so deleting strategy_retrieval_document here is safe and scoped.
    await db.delete(strategyRetrievalDocument);
  });

  it('upserts a document and reads it back', async () => {
    await adapter.upsert(doc());
    const found = await adapter.findByProfileId('sp-1');
    expect(found).not.toBeNull();
    expect(found?.strategyProfileId).toBe('sp-1');
    expect(found?.content).toBe('long after a flush on the 1m timeframe');
    expect(found?.contentHash).toBe('sha256:content-1');
    expect(found?.embeddingModel).toBe(MODEL);
    expect(found?.indexVersion).toBe(VERSION);
    expect(found?.embedding).toHaveLength(DIM);
  });

  it('upsert replaces an existing projection (keyed by strategyProfileId)', async () => {
    await adapter.upsert(doc());
    await adapter.upsert(doc({
      content: 'short before a squeeze',
      contentHash: 'sha256:content-2',
      embedding: vec(2),
      metadata: { market: 'crypto', symbol: 'ETHUSDT', timeframe: '5m', direction: 'short', label: 'Short squeeze' },
      indexedAt: '2026-06-18T13:00:00.000Z',
    }));
    const found = await adapter.findByProfileId('sp-1');
    expect(found?.content).toBe('short before a squeeze');
    expect(found?.contentHash).toBe('sha256:content-2');
    expect(found?.metadata.symbol).toBe('ETHUSDT');
    expect(found?.metadata.direction).toBe('short');
  });

  it('round-trips metadata', async () => {
    await adapter.upsert(doc({
      metadata: { market: 'crypto', symbol: 'BTCUSDT', timeframe: '1m', direction: 'both', profileVersion: 3, label: 'L', createdAt: '2026-06-18T11:00:00.000Z' },
    }));
    const found = await adapter.findByProfileId('sp-1');
    expect(found?.metadata).toEqual({
      market: 'crypto',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      direction: 'both',
      profileVersion: 3,
      label: 'L',
      createdAt: '2026-06-18T11:00:00.000Z',
    });
  });

  it('deletes a projection', async () => {
    await adapter.upsert(doc());
    expect(await adapter.findByProfileId('sp-1')).not.toBeNull();
    await adapter.delete('sp-1');
    expect(await adapter.findByProfileId('sp-1')).toBeNull();
  });

  it('delete of an unknown profile is a no-op', async () => {
    await expect(adapter.delete('does-not-exist')).resolves.toBeUndefined();
  });

  it('findByProfileId returns null for an unknown profile', async () => {
    expect(await adapter.findByProfileId('nope')).toBeNull();
  });

  // ---- 1024-dim validation BEFORE any SQL ----

  it('rejects a wrong-length embedding before issuing SQL', async () => {
    await expect(adapter.upsert(doc({ embedding: vec(1, 512) }))).rejects.toThrow();
    // nothing was written
    expect(await adapter.findByProfileId('sp-1')).toBeNull();
  });

  it('rejects a non-finite embedding before issuing SQL', async () => {
    const bad = vec(1);
    bad[10] = Number.NaN;
    await expect(adapter.upsert(doc({ embedding: bad }))).rejects.toThrow();
    expect(await adapter.findByProfileId('sp-1')).toBeNull();

    const bad2 = vec(1);
    bad2[20] = Number.POSITIVE_INFINITY;
    await expect(adapter.upsert(doc({ embedding: bad2 }))).rejects.toThrow();
    expect(await adapter.findByProfileId('sp-1')).toBeNull();
  });

  // ---- stale index_version / embedding_model exclusion ----

  it('excludes a row whose index_version differs from the configured version (stale -> null)', async () => {
    await adapter.upsert(doc({ indexVersion: VERSION + 1 }));
    // The configured adapter reads version=VERSION; the row is version=VERSION+1 -> stale.
    expect(await adapter.findByProfileId('sp-1')).toBeNull();
  });

  it('excludes a row whose embedding_model differs from the configured model (stale -> null)', async () => {
    await adapter.upsert(doc({ embeddingModel: 'some/other-model' }));
    expect(await adapter.findByProfileId('sp-1')).toBeNull();
  });

  it('returns a row that matches both configured version and model', async () => {
    await adapter.upsert(doc());
    const found = await adapter.findByProfileId('sp-1');
    expect(found?.indexVersion).toBe(VERSION);
    expect(found?.embeddingModel).toBe(MODEL);
  });
});
