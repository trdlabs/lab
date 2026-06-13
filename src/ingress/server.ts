import { serve } from '@hono/node-server';
import { composeRuntime } from '../composition.ts';
import { createIngressApp } from './app.ts';
import { createChatApp } from '../chat/chat-app.ts';
import { createReadApp } from '../read-api/read-app.ts';

const { env, services, queue, pool, chat, read } = composeRuntime();
const app = createIngressApp({ repo: services.researchTasks, queue });
app.route('/chat', createChatApp(chat));
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);

if (env.TRADING_LAB_READ_TOKEN) {
  serve({ fetch: createReadApp(read).fetch, port: env.READ_API_PORT });
  console.log(`read API listening on :${env.READ_API_PORT}`);
} else {
  console.warn('[read-api] TRADING_LAB_READ_TOKEN not set — read API listener not started');
}

const shutdown = async () => {
  await queue.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
