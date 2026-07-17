// Harness test for scripts/outcome-embargo-smoke.sh (F5a, brief step 5).
//
// The script is a post-deploy smoke check: it hits the DEPLOYED lab read path
// (GET /v1/tasks/:taskId/completion-summary) for a task an operator has seeded with a
// held-out outcome fixture, and must exit non-zero if any configured "held-out marker"
// (standing in for a real held-out outcome value / qualification verdict) shows up in the
// response body. This harness boots the real read-API app (in-memory adapters) as an
// actual HTTP listener — the closest in-process stand-in for "the deployed read path" —
// then drives the script as a subprocess against it via SMOKE_BASE_URL.
//
// Before the script exists, spawnSync fails to exec it (ENOENT) and every assertion below
// fails — this file is written BEFORE scripts/outcome-embargo-smoke.sh (TDD RED).
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { createReadApp } from '../src/read-api/read-app.ts';
import type { ReadApiDeps } from '../src/read-api/deps.ts';
import { InMemoryHypothesisReadAdapter } from '../src/adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../src/adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../src/adapters/read/in-memory-agent-event-read.adapter.ts';
import { AgentActivityProjection } from '../src/read-api/projection.ts';
import { InMemoryAgentEventStream } from '../src/adapters/read/in-memory-agent-event-stream.ts';
import { InMemoryExperimentReadAdapter } from '../src/adapters/read/in-memory-experiment-read.adapter.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'outcome-embargo-smoke.sh');
const TOKEN = 'smoke-test-token';

// Stand-ins for a real held-out outcome value + its qualification verdict. Distinctive
// enough that they can never collide with legitimate response content.
const HELDOUT_MARKERS = ['__HELDOUT_SHARPE_9.999_MARKER__', '__QUALIFICATION_VERDICT_LEAK_MARKER__'] as const;

function baseDeps(over: Partial<ReadApiDeps> = {}): ReadApiDeps {
  return {
    hypotheses: new InMemoryHypothesisReadAdapter([]),
    backtests: new InMemoryBacktestReadAdapter([]),
    agentEvents: new InMemoryAgentEventReadAdapter([]),
    projection: new AgentActivityProjection(50),
    agentStream: new InMemoryAgentEventStream(),
    streamHeartbeatMs: 60_000,
    checkReadiness: async () => true,
    token: TOKEN,
    researchTasks: { findById: async () => null },
    strategyProfiles: { findById: async () => null },
    tokenUsage: { getCost: async () => 0 },
    phoenixTraces: { getAgentTraces: async (agentId: string) => ({ agentId, reasonCode: 'tracing-disabled' as const, traces: [] }) },
    experiments: new InMemoryExperimentReadAdapter(),
    cycleScorecards: { findByCorrelationAndSchema: async () => null, findByCorrelation: async () => [], upsert: async () => {} },
    ...over,
  };
}

function taskWithReasons(id: string, reasons: string[]) {
  return async () => ({
    id, taskType: 'backtest.completed' as const, status: 'completed' as const, source: 'operator' as const,
    correlationId: 'c1', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    payload: { backtestRunId: 'b1', decision: 'PASS', reasons, cycleDepth: 0 },
  });
}

function startServer(deps: ReadApiDeps): Promise<{ server: ServerType; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = createReadApp(deps);
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ server, baseUrl: `http://127.0.0.1:${info.port}` });
    });
  });
}

function stopServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// spawn (async), NOT spawnSync: the fixture server below runs in-process on this same
// event loop. A synchronous child-process call would block that loop while curl (a
// separate process) tries to connect to it — a self-deadlock masked only by curl's own
// --max-time timeout. Async spawn keeps the loop free to service the HTTP server.
function runScript(env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT_PATH], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.on('error', (err) => resolve({ status: null, stdout, stderr: stderr + String(err) }));
  });
}

describe('outcome-embargo-smoke.sh (deployed read-path smoke)', () => {
  let server: ServerType | undefined;

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = undefined;
    }
  });

  it('exits non-zero and never echoes the marker when the read path leaks a held-out outcome', async () => {
    const started = await startServer(baseDeps({
      researchTasks: { findById: taskWithReasons('leak-1', [HELDOUT_MARKERS[0], HELDOUT_MARKERS[1], 'drawdown_regression']) },
    }));
    server = started.server;

    const result = await runScript({
      SMOKE_BASE_URL: started.baseUrl,
      SMOKE_READ_TOKEN: TOKEN,
      SMOKE_TASK_ID: 'leak-1',
      SMOKE_HELDOUT_MARKERS: HELDOUT_MARKERS.join(','),
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain(HELDOUT_MARKERS[0]);
    expect(result.stdout).not.toContain(HELDOUT_MARKERS[1]);
    expect(result.stderr).not.toContain(HELDOUT_MARKERS[0]);
    expect(result.stderr).not.toContain(HELDOUT_MARKERS[1]);
    expect(result.stderr).not.toContain(TOKEN);
  });

  it('exits zero when the read path does not return the held-out markers', async () => {
    const started = await startServer(baseDeps({
      researchTasks: { findById: taskWithReasons('clean-1', ['drawdown_regression', 'no_improvement_over_baseline']) },
    }));
    server = started.server;

    const result = await runScript({
      SMOKE_BASE_URL: started.baseUrl,
      SMOKE_READ_TOKEN: TOKEN,
      SMOKE_TASK_ID: 'clean-1',
      SMOKE_HELDOUT_MARKERS: HELDOUT_MARKERS.join(','),
    });

    expect(result.status).toBe(0);
  });

  it('fails closed (non-zero) when the seeded fixture/task cannot be found', async () => {
    const started = await startServer(baseDeps());
    server = started.server;

    const result = await runScript({
      SMOKE_BASE_URL: started.baseUrl,
      SMOKE_READ_TOKEN: TOKEN,
      SMOKE_TASK_ID: 'does-not-exist',
      SMOKE_HELDOUT_MARKERS: HELDOUT_MARKERS.join(','),
    });

    expect(result.status).not.toBe(0);
  });

  it('fails closed (non-zero) with a bad read token', async () => {
    const started = await startServer(baseDeps({
      researchTasks: { findById: taskWithReasons('clean-2', ['drawdown_regression']) },
    }));
    server = started.server;

    const result = await runScript({
      SMOKE_BASE_URL: started.baseUrl,
      SMOKE_READ_TOKEN: 'wrong-token',
      SMOKE_TASK_ID: 'clean-2',
      SMOKE_HELDOUT_MARKERS: HELDOUT_MARKERS.join(','),
    });

    expect(result.status).not.toBe(0);
  });

  it('rejects missing required arguments before ever reaching the network', async () => {
    const result = await runScript({
      SMOKE_BASE_URL: 'http://127.0.0.1:1',
      SMOKE_READ_TOKEN: TOKEN,
      SMOKE_TASK_ID: '',
      SMOKE_HELDOUT_MARKERS: HELDOUT_MARKERS.join(','),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
