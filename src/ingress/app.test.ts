import { describe, it, expect } from 'vitest';
import type { Hono } from 'hono';
import { createIngressApp } from './app.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryBacktestRunRepository } from '../adapters/repository/in-memory-backtest-run.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';

const TASK_TOKEN = 'task-secret';
const CALLBACK_TOKEN = 'callback-secret';
const NOW = '2026-01-01T00:00:00Z';

function platformRun(over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id: 'br1', hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'platform-run-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh',
    status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1',
    backend: 'research_platform', resumeToken: 'tok', taskId: 't1',
    platformRun: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 },
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: 'builder-sdk-v0',
    submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

const validCallback = JSON.stringify({
  eventType: 'job_completed',
  jobId: 'job-1',
  runId: 'platform-run-1',
  status: 'completed',
  summary: {},
  emittedAtMs: 1,
});

// Pass { taskToken: undefined } / { callbackToken: undefined } to exercise the unset (503) path.
function setup(tokens: { taskToken?: string; callbackToken?: string; withBacktests?: boolean } = {}) {
  const repo = new InMemoryResearchTaskRepository();
  const queue = new InMemoryQueueAdapter();
  const backtests = new InMemoryBacktestRunRepository();
  const app = createIngressApp({
    repo,
    queue,
    taskToken: 'taskToken' in tokens ? tokens.taskToken : TASK_TOKEN,
    callbackToken: 'callbackToken' in tokens ? tokens.callbackToken : CALLBACK_TOKEN,
    ...(tokens.withBacktests !== false
      ? { findRunByPlatformRunId: (id) => backtests.findByPlatformRunId(id) }
      : {}),
  });
  return { app, repo, queue, backtests };
}

const validTask = JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } });

function postTask(app: Hono, body: string, token?: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token != null) headers.authorization = `Bearer ${token}`;
  return app.request('/tasks', { method: 'POST', headers, body });
}

function postCallback(
  app: Hono,
  body: string = validCallback,
  opts: { bearer?: string | null; queryToken?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer != null) headers.authorization = `Bearer ${opts.bearer}`;
  const url = opts.queryToken
    ? `/callbacks/backtest-completed?token=${encodeURIComponent(opts.queryToken)}`
    : '/callbacks/backtest-completed';
  return app.request(url, { method: 'POST', headers, body });
}

describe('Ingress POST /tasks (authorized)', () => {
  it('accepts a valid task, persists it, and enqueues an envelope', async () => {
    const { app, repo, queue } = setup();
    const res = await postTask(app, validTask, TASK_TOKEN);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { taskId: string; status: string };
    expect(body.status).toBe('queued');
    expect((await repo.findById(body.taskId))?.status).toBe('queued');
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]!.taskId).toBe(body.taskId);
  });

  it('rejects an invalid payload with 400 (auth passed, validation ran)', async () => {
    const { app, queue } = setup();
    const res = await postTask(app, JSON.stringify({ taskType: 'nope', source: 'web' }), TASK_TOKEN);
    expect(res.status).toBe(400);
    expect(queue.queued).toHaveLength(0);
  });

  it('deduplicates by dedupeKey: second call returns the same taskId without re-enqueue', async () => {
    const { app, queue } = setup();
    const body = JSON.stringify({ taskType: 'strategy.onboard', source: 'web', dedupeKey: 'k1', payload: {} });
    const first = (await (await postTask(app, body, TASK_TOKEN)).json()) as { taskId: string };
    const second = (await (await postTask(app, body, TASK_TOKEN)).json()) as { taskId: string };
    expect(second.taskId).toBe(first.taskId);
    expect(queue.queued).toHaveLength(1);
  });
});

describe('Ingress POST /tasks auth gate', () => {
  it('503 service_unavailable when the task token is unset', async () => {
    const { app } = setup({ taskToken: undefined });
    const res = await postTask(app, validTask, 'anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'task ingress not configured' } });
  });

  it('401 when the task token is set but the Bearer value is wrong', async () => {
    const { app } = setup();
    const res = await postTask(app, validTask, 'nope');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
  });

  it('401 when the Authorization header is missing', async () => {
    const { app } = setup();
    expect((await postTask(app, validTask, null)).status).toBe(401);
  });
});

describe('Ingress POST /callbacks/backtest-completed auth gate', () => {
  it('503 when the callback token is unset', async () => {
    const { app } = setup({ callbackToken: undefined });
    const res = await postCallback(app, validCallback, { bearer: 'anything' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'callback ingress not configured' } });
  });

  it('401 when the callback token is wrong', async () => {
    const { app } = setup();
    expect((await postCallback(app, validCallback, { bearer: 'nope' })).status).toBe(401);
  });

  it('202 enqueues backtest.resume when Bearer token matches and run exists', async () => {
    const { app, queue, backtests } = setup();
    await backtests.createSubmitted(platformRun());
    const res = await postCallback(app, validCallback, { bearer: CALLBACK_TOKEN });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'accepted', action: 'enqueued' });
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]!.taskType).toBe('backtest.resume');
  });

  it('202 accepts query ?token= without Bearer (backtester webhook shape)', async () => {
    const { app, queue, backtests } = setup();
    await backtests.createSubmitted(platformRun());
    const res = await postCallback(app, validCallback, { queryToken: CALLBACK_TOKEN });
    expect(res.status).toBe(202);
    expect(queue.queued).toHaveLength(1);
  });

  it('503 when findRunByPlatformRunId is not wired', async () => {
    const { app } = setup({ withBacktests: false });
    const res = await postCallback(app, validCallback, { bearer: CALLBACK_TOKEN });
    expect(res.status).toBe(503);
  });
});

describe('Ingress cross-token isolation', () => {
  it('the task token does NOT authorize /callbacks', async () => {
    const { app } = setup();
    expect((await postCallback(app, validCallback, { bearer: TASK_TOKEN })).status).toBe(401);
  });

  it('the callback token does NOT authorize /tasks', async () => {
    const { app } = setup();
    expect((await postTask(app, validTask, CALLBACK_TOKEN)).status).toBe(401);
  });
});

describe('Ingress gate precedes body parsing', () => {
  const malformed = '{ not json';

  it('malformed body with no token -> 503 (not 400)', async () => {
    const { app, queue } = setup({ taskToken: undefined });
    const res = await postTask(app, malformed, null);
    expect(res.status).toBe(503);
    expect(queue.queued).toHaveLength(0);
  });

  it('malformed body with a wrong token -> 401 (not 400)', async () => {
    const { app, queue } = setup();
    const res = await postTask(app, malformed, 'nope');
    expect(res.status).toBe(401);
    expect(queue.queued).toHaveLength(0);
  });

  it('malformed body with the correct token -> 400 (validation runs after the gate)', async () => {
    const { app, queue } = setup();
    const res = await postTask(app, malformed, TASK_TOKEN);
    expect(res.status).toBe(400);
    expect(queue.queued).toHaveLength(0);
  });
});

describe('[P1-18] GET /healthz (always-on liveness)', () => {
  it('returns 200 without a token — the ingress process is up on :3000 regardless of the optional read listener', async () => {
    const { app } = setup();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('is reachable even when no task/callback tokens are configured', async () => {
    const { app } = setup({ taskToken: undefined, callbackToken: undefined });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });
});
