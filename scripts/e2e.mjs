#!/usr/bin/env node
/**
 * e2e smoke — полный исследовательский цикл.
 * Запускается внутри ingress-контейнера через stdin pipe:
 *   docker compose ... exec -T ingress node --input-type=module < scripts/e2e.mjs
 *
 * Алгоритм:
 *   1. POST /tasks → strategy.onboard (фиксированный контент)
 *   2. POLL /v1/agent-events?taskId=<id> до strategy.onboard.deduped ИЛИ strategy_analyst.completed
 *      a) deduped → profileId из payload.strategyId, переход к шагу 4
 *      b) completed → sleep 2s → повторный POST → deduped → profileId
 *   3. POST /tasks → research.run_cycle { strategyProfileId }
 *   4. POLL /v1/agent-events?taskId=<id2> до research.run_cycle.completed (таймаут 8 мин)
 *   5. EXIT 0 PASS / EXIT 1 FAIL
 */

const INGRESS_URL          = 'http://localhost:3000';
const READ_API_URL         = 'http://localhost:3100';
const TASK_TOKEN           = process.env.TRADING_LAB_TASK_TOKEN ?? 'demo-task-token';
const READ_TOKEN           = process.env.TRADING_LAB_READ_TOKEN ?? 'demo-read-token';
const ONBOARD_TIMEOUT_MS   = 5 * 60 * 1000;
const RESEARCH_TIMEOUT_MS  = 8 * 60 * 1000;
const POLL_INTERVAL_MS     = 2_000;
const RESEARCH_POLL_MS     = 5_000;

// Фиксированный контент — первый запуск создаёт профиль, последующие дают deduped
const E2E_CONTENT = `// e2e-smoke strategy — do not modify
function run(ctx) { return ctx.signals.slice(0, 1); }
`;

const start = Date.now();
const elapsed = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;

function log(msg) { console.log(`[e2e ${elapsed()}] ${msg}`); }
function fail(reason) { console.error(`[e2e ${elapsed()}] FAIL  ${reason}`); process.exit(1); }

async function postTask(payload) {
  const res = await fetch(`${INGRESS_URL}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TASK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /tasks ${res.status}: ${text}`);
  }
  return res.json();
}

async function pollEvents(taskId, predicate, timeoutMs, intervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs;
  let after = undefined;
  while (Date.now() < deadline) {
    const url = new URL(`${READ_API_URL}/v1/agent-events`);
    url.searchParams.set('taskId', taskId);
    if (after) url.searchParams.set('cursor', after);
    url.searchParams.set('limit', '50');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
    });
    if (!res.ok) throw new Error(`GET /v1/agent-events ${res.status}`);

    const body = await res.json();
    for (const ev of body.data ?? []) {
      const result = predicate(ev);
      if (result !== null && result !== undefined && result !== false) return result;
    }
    if (body.page?.nextCursor) {
      after = body.page.nextCursor;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Шаг 1: Onboard ──────────────────────────────────────────────────────────
log('submitting strategy.onboard…');
let onboardTask;
try {
  onboardTask = await postTask({
    taskType: 'strategy.onboard',
    source: 'e2e',
    correlationId: `e2e-${Date.now()}`,
    payload: { kind: 'bot_code', content: E2E_CONTENT },
  });
} catch (err) {
  fail(`strategy.onboard submit: ${err.message}`);
}
const taskId1 = onboardTask.taskId;
log(`strategy.onboard taskId=${taskId1}`);

// ── Шаг 2: Ждём profileId ───────────────────────────────────────────────────
log('waiting for strategy profile (deduped or analyst.completed)…');
let profileId = await pollEvents(taskId1, ev => {
  if (ev.type === 'strategy.onboard.deduped') {
    log(`deduped: strategyId=${ev.payload?.strategyId}`);
    return ev.payload?.strategyId ?? null;
  }
  if (ev.type === 'strategy_analyst.completed') {
    log('analyst.completed (fresh profile), will re-submit to get profileId…');
    return 'FRESH';
  }
  return false;
}, ONBOARD_TIMEOUT_MS);

if (profileId === null) fail(`strategy.onboard timed out after ${ONBOARD_TIMEOUT_MS / 1000}s`);

if (profileId === 'FRESH') {
  // ── Шаг 3: Повторный POST чтобы получить deduped с profileId ──────────────
  await sleep(2_000);
  log('re-submitting strategy.onboard to extract profileId via dedup…');
  let dedupeTask;
  try {
    dedupeTask = await postTask({
      taskType: 'strategy.onboard',
      source: 'e2e',
      correlationId: `e2e-dedup-${Date.now()}`,
      payload: { kind: 'bot_code', content: E2E_CONTENT },
    });
  } catch (err) {
    fail(`strategy.onboard dedup-submit: ${err.message}`);
  }
  const taskId1b = dedupeTask.taskId;
  log(`dedup taskId=${taskId1b}, waiting for strategy.onboard.deduped…`);
  profileId = await pollEvents(taskId1b, ev => {
    if (ev.type === 'strategy.onboard.deduped') {
      log(`deduped: strategyId=${ev.payload?.strategyId}`);
      return ev.payload?.strategyId ?? null;
    }
    return false;
  }, ONBOARD_TIMEOUT_MS);
  if (!profileId) fail('could not extract strategyProfileId from dedup event');
}

log(`strategyProfileId=${profileId}`);

// ── Шаг 4: research.run_cycle ───────────────────────────────────────────────
log('submitting research.run_cycle…');
let cycleTask;
try {
  cycleTask = await postTask({
    taskType: 'research.run_cycle',
    source: 'e2e',
    correlationId: `e2e-cycle-${Date.now()}`,
    payload: { strategyProfileId: profileId },
  });
} catch (err) {
  fail(`research.run_cycle submit: ${err.message}`);
}
const taskId2 = cycleTask.taskId;
log(`research.run_cycle taskId=${taskId2}`);

// ── Шаг 5: Ждём research.run_cycle.completed ────────────────────────────────
log('waiting for research.run_cycle.completed (up to 8 min)…');
const cycleResult = await pollEvents(taskId2, ev => {
  if (ev.type === 'research.run_cycle.completed') return 'DONE';
  if (ev.type === 'research.run_cycle.failed') return `FAILED:${ev.payload?.error ?? 'unknown'}`;
  return false;
}, RESEARCH_TIMEOUT_MS, RESEARCH_POLL_MS);

if (!cycleResult) fail(`research.run_cycle timed out after ${RESEARCH_TIMEOUT_MS / 1000}s`);
if (cycleResult.startsWith('FAILED:')) fail(cycleResult);

log(`PASS  (total ${elapsed()})`);
