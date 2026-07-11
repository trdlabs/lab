import { describe, it, expect, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { createDbClient } from './client.ts';

const pools: Pool[] = [];
afterEach(async () => { while (pools.length) await pools.pop()!.end(); });

describe('createDbClient', () => {
  it('applies the max pool size when provided', () => {
    const { pool } = createDbClient('postgres://u:p@localhost:5432/db', { max: 20 });
    pools.push(pool);
    expect(pool.options.max).toBe(20);
  });

  it('leaves node-pg default when max is omitted', () => {
    const { pool } = createDbClient('postgres://u:p@localhost:5432/db');
    pools.push(pool);
    expect(pool.options.max).toBe(10);
  });
});
