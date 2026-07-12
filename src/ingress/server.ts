import { serve } from '@hono/node-server';
import { composeRuntime } from '../composition.ts';
import { createIngressApp } from './app.ts';
import { createChatApp } from '../chat/chat-app.ts';
import { createReadApp } from '../read-api/read-app.ts';
import { installProcessSafetyNet } from '../process-safety.ts';

const { env, services, queue, pool, chat, read } = composeRuntime();
const app = createIngressApp({
  repo: services.researchTasks,
  queue,
  taskToken: env.TRADING_LAB_TASK_TOKEN,
  callbackToken: env.TRADING_LAB_CALLBACK_TOKEN,
  findRunByPlatformRunId: (platformRunId) => services.backtests.findByPlatformRunId(platformRunId),
});
app.route('/chat', createChatApp(chat));
if (!env.TRADING_LAB_CHAT_TOKEN) {
  console.warn('[chat] TRADING_LAB_CHAT_TOKEN not set — POST /chat/messages will reject all requests (503)');
}
if (!env.TRADING_LAB_TASK_TOKEN) {
  console.warn('[ingress] TRADING_LAB_TASK_TOKEN not set — POST /tasks will reject all requests (503)');
}
if (!env.TRADING_LAB_CALLBACK_TOKEN) {
  console.warn('[ingress] TRADING_LAB_CALLBACK_TOKEN not set — POST /callbacks/backtest-completed will reject all requests (503)');
}
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);

if (env.TRADING_LAB_READ_TOKEN) {
  // Rebuild the projection from the tail of agent_event, then go live.
  const sinceMs = Date.now() - env.AGENT_ACTIVITY_REBUILD_WINDOW_HOURS * 3_600_000;
  const since = new Date(sinceMs).toISOString();
  let cur: { t: string; id: string } | undefined;
  for (;;) {
    const rows = await read.agentEvents.list({ since, after: cur, limit: 500 });
    if (rows.length === 0) break;
    for (const row of rows) read.projection.apply(row);
    cur = { t: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.id };
    if (rows.length < 500) break;
  }
  read.agentStream.subscribe((row) => read.projection.apply(row));
  await read.agentStream.start(read.projection.cursorKey());

  serve({ fetch: createReadApp(read).fetch, port: env.READ_API_PORT });
  console.log(`read API listening on :${env.READ_API_PORT}`);
} else {
  console.warn('[read-api] TRADING_LAB_READ_TOKEN not set — read API listener not started');
}

const shutdown = async (code = 0) => {
  if (env.TRADING_LAB_READ_TOKEN) await read.agentStream.stop();
  await queue.close();
  await pool.end();
  process.exit(code);
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
installProcessSafetyNet({ onFatal: () => { void shutdown(1); } });
