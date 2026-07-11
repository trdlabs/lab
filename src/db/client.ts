import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

export function createDbClient(databaseUrl: string, opts?: { max?: number }): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: databaseUrl, ...(opts?.max !== undefined ? { max: opts.max } : {}) });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
