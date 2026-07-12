import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

export function createDbClient(
  databaseUrl: string,
  opts?: { max?: number; onError?: (err: Error) => void },
): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: databaseUrl, ...(opts?.max !== undefined ? { max: opts.max } : {}) });
  // pg.Pool is an EventEmitter that rethrows 'error' (emitted for idle clients on a
  // backend restart / network blip) as an uncaught exception when unlistened — which
  // crashes the whole process. Always keep a listener attached.
  pool.on('error', opts?.onError ?? ((err) => console.error('[db] idle pool client error', err)));
  const db = drizzle(pool, { schema });
  return { db, pool };
}
