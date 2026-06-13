import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { backtestRun } from '../../db/schema.ts';
import { DrizzleBacktestReadAdapter } from './drizzle-backtest-read.adapter.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleBacktestReadAdapter', () => {
  const { db, pool } = createDbClient(url!);
  const ids = ['sp5r1', 'sp5r2', 'sp5r3'];

  beforeAll(async () => {
    await db.delete(backtestRun).where(inArray(backtestRun.id, ids));
    let i = 1;
    for (const id of ids) {
      await db.insert(backtestRun).values({
        id, hypothesisBuildId: 'b', hypothesisId: id === 'sp5r3' ? 'hB' : 'hA', strategyProfileId: 'p',
        platformRunId: 'mock', correlationId: 'c', params: {}, paramsHash: `ph-${id}`, bundleHash: `bh-${id}`,
        status: 'completed', baselineModuleId: 'm0', variantModuleId: 'm1',
        artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: 'sdk-0',
        submittedAt: new Date(`2026-02-0${i}T00:00:00Z`), createdAt: new Date(`2026-02-0${i}T00:00:00Z`), updatedAt: new Date(`2026-02-0${i}T00:00:00Z`),
      });
      i++;
    }
  });

  afterAll(async () => {
    await db.delete(backtestRun).where(inArray(backtestRun.id, ids));
    await pool.end();
  });

  it('lists newest-first within a hypothesis filter', async () => {
    const a = new DrizzleBacktestReadAdapter(db);
    expect((await a.list({ hypothesisId: 'hA', limit: 50 })).map((r) => r.id)).toEqual(['sp5r2', 'sp5r1']);
    expect((await a.list({ hypothesisId: 'hB', limit: 50 })).map((r) => r.id)).toEqual(['sp5r3']);
  });

  it('keyset paginates', async () => {
    const a = new DrizzleBacktestReadAdapter(db);
    const page1 = await a.list({ limit: 1, hypothesisId: 'hA' });
    expect(page1[0]!.id).toBe('sp5r2');
    const after = { t: page1[0]!.createdAt, id: page1[0]!.id };
    const page2 = await a.list({ limit: 1, hypothesisId: 'hA', after });
    expect(page2[0]!.id).toBe('sp5r1');
  });
});
