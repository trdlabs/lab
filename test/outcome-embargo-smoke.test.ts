// Harness test for scripts/outcome-embargo-smoke.sh (F5a, brief step 5).
//
// scripts/outcome-embargo-smoke.sh is a two-tier post-deploy smoke check:
//   PRIMARY   generation_lane_check — execs into the deployed U6 worker container and runs
//             scripts/embargo-enforcement-probe.mjs against the IMAGE's own copy of
//             src/research/outcome-embargo.ts. This is the actual embargo-enforcement
//             coverage. It cannot run against a real container in CI, so it is instead
//             covered below (see the second describe block) by running the SAME probe
//             directly against the LOCAL build — the CI-safe substitute.
//   SECONDARY read_api_canary — hits the DEPLOYED lab read path
//             (GET /v1/tasks/:taskId/completion-summary) and must exit non-zero if any
//             configured "held-out marker" (standing in for a real held-out outcome value /
//             qualification verdict) shows up in the response body. This is an
//             OPERATOR-SURFACE REGRESSION CANARY, NOT embargo-enforcement coverage — the
//             read API by design returns full holdout data to operators (see
//             src/research/outcome-embargo.ts's module docstring); it only catches the
//             read-API surface regressing (unreachable, bad auth, malformed response).
//
// This first describe block covers read_api_canary: it boots the real read-API app
// (in-memory adapters) as an actual HTTP listener — the closest in-process stand-in for
// "the deployed read path" — then drives the script as a subprocess against it via
// SMOKE_BASE_URL (which also skips generation_lane_check, since there is no container to
// exec into in this mode — see the script's header comment).
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('outcome-embargo-smoke.sh — read_api_canary (secondary, operator-surface regression check, NOT embargo-enforcement coverage)', () => {
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

// ---------------------------------------------------------------------------------------
// scripts/embargo-enforcement-probe.mjs — generation-lane embargo enforcement (PRIMARY
// check). This is the CI-safe substitute for generation_lane_check's in-container run: it
// runs the SAME probe file scripts/outcome-embargo-smoke.sh execs into the deployed worker
// container, but against the LOCAL build (src/research/outcome-embargo.ts on the host
// checkout) instead of a running container's /app tree.
const PROBE_PATH = path.join(__dirname, '..', 'scripts', 'embargo-enforcement-probe.mjs');
const REAL_MODULE_PATH = path.join(__dirname, '..', 'src', 'research', 'outcome-embargo.ts');
const PROBE_NODE_FLAGS = ['--experimental-transform-types'];

const probeTmpDirs: string[] = [];

function runProbe(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [...PROBE_NODE_FLAGS, PROBE_PATH], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('embargo-enforcement-probe.mjs — generation-lane enforcement (primary check, run against the local build)', () => {
  afterAll(() => {
    for (const dir of probeTmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 when the real outcome-embargo module scrubs the marker from both scrubMetricsBag and sanitizeRetryFeedback', () => {
    const result = runProbe({ EMBARGO_MODULE_PATH: REAL_MODULE_PATH });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits non-zero and never echoes the marker when scrubbing is broken (module passes the marker through unchanged)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'embargo-probe-passthrough-'));
    probeTmpDirs.push(dir);
    const stubPath = path.join(dir, 'passthrough.mjs');
    writeFileSync(
      stubPath,
      [
        'export function scrubMetricsBag(bag) { return { scrubbed: bag, removedKeys: [] }; }',
        'export function sanitizeRetryFeedback(feedback) {',
        '  return {',
        '    feedback: { hypothesisId: feedback.hypothesisId, decision: feedback.decision, reasons: [...feedback.reasons] },',
        '    removedKeys: [],',
        '  };',
        '}',
        '',
      ].join('\n'),
    );

    const marker = '__PROBE_TEST_MARKER_XYZ__';
    const result = runProbe({ EMBARGO_MODULE_PATH: stubPath, EMBARGO_MARKER: marker });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain(marker);
    expect(result.stderr).not.toContain(marker);
  });

  it('fails closed (non-zero) when scrubMetricsBag/sanitizeRetryFeedback are missing from the imported module', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'embargo-probe-missing-'));
    probeTmpDirs.push(dir);
    const stubPath = path.join(dir, 'missing.mjs');
    writeFileSync(stubPath, 'export const notTheRightExports = true;\n');

    const result = runProbe({ EMBARGO_MODULE_PATH: stubPath });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing');
  });

  it('fails closed (non-zero) when EMBARGO_MODULE_PATH is not set', () => {
    const result = runProbe({ EMBARGO_MODULE_PATH: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EMBARGO_MODULE_PATH is required');
  });

  it('fails closed (non-zero) when EMBARGO_MODULE_PATH points at a module that fails to import', () => {
    const result = runProbe({ EMBARGO_MODULE_PATH: path.join(tmpdir(), 'does-not-exist-embargo-module.mjs') });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed to import');
  });
});
