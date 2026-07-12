import { describe, it, expect, afterEach, vi } from 'vitest';
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

  it("registers a pool 'error' handler so an idle-client error does not crash the process", () => {
    const onError = vi.fn();
    const { pool } = createDbClient('postgres://u:p@localhost:5432/db', { onError });
    pools.push(pool);
    // Without a listener, node-pg's Pool (an EventEmitter) rethrows 'error' as an
    // uncaught exception — the nightly-crash class this handler removes.
    expect(() => pool.emit('error', new Error('idle client terminated'))).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
