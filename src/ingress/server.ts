import { serve } from '@hono/node-server';
import { composeRuntime } from '../composition.ts';
import { createIngressApp } from './app.ts';

const { env, repo, queue, pool } = composeRuntime();
const app = createIngressApp({ repo, queue });
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);

// Graceful shutdown: close the queue connection and the pg pool.
const shutdown = async () => {
  await queue.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
