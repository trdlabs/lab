// Controlled enablement sweep driver — trading-lab client chain (SDK BacktesterClient) against a
// local trading-backtester (dedup+coalesce+obs all ON) + local mock-platform historical fixture.
// See trading-backtester CLAUDE.md task for full spec. Run: tsx scripts/enablement-sweep.mts
import { readFileSync, writeFileSync } from 'node:fs';
import { BacktesterClient } from '@trading-backtester/sdk/client';

const BASE_URL = 'http://127.0.0.1:18080';
const TOKEN = 'dev-token';
const BUNDLE_PATH = '/home/alexxxnikolskiy/long_oi-bundle.json';
const OUT_PATH = '/tmp/claude-1000/-home-alexxxnikolskiy-projects-trading-backtester/18e11c7c-0aa9-49c5-be76-5386d87ade20/scratchpad/sweep-results.json';

const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));

function reqFor(symbol: string) {
  return {
    mode: 'research' as const,
    engine: 'strategy' as const,
    moduleRef: { id: 'long_oi_dump_reversal_v1', version: '1.0.0' },
    moduleBundle: bundle,
    datasetRef: `${symbol}:1m`,
    symbols: [symbol],
    timeframe: '1m',
    period: { from: '2026-06-16T00:00:00.000Z', to: '2026-06-18T00:00:00.000Z' },
    seed: 42,
    metrics: ['pnl', 'win_rate'],
    riskProfileRef: { id: 'default_risk', version: '1.0.0' },
    executionProfileRef: { id: 'default_exec', version: '1.0.0' },
  };
}

const client = new BacktesterClient({ baseUrl: BASE_URL, token: TOKEN });

type RunRecord = {
  label: string;
  submittedAtMs: number;
  runId?: string;
  jobId?: string;
  acceptedAtMs?: number;
  terminalAtMs?: number;
  status?: string;
  terminalCode?: string;
  resultHash?: string;
  metrics?: unknown;
  error?: string;
};

const results: RunRecord[] = [];

async function submit(label: string, symbol: string): Promise<RunRecord> {
  const rec: RunRecord = { label, submittedAtMs: Date.now() };
  try {
    const handle = await client.submitRun(reqFor(symbol));
    rec.runId = handle.runId;
    rec.jobId = (handle as any).jobId;
  } catch (err) {
    rec.error = `submit failed: ${String((err as Error)?.message ?? err)}`;
  }
  return rec;
}

async function pollToTerminal(rec: RunRecord, maxMs = 180_000, intervalMs = 1000): Promise<void> {
  if (!rec.runId || rec.error) return;
  const deadline = Date.now() + maxMs;
  const TERMINAL = new Set(['completed', 'failed', 'canceled', 'expired', 'timed_out']);
  for (;;) {
    const view = await client.getRunStatus(rec.runId);
    rec.status = view.status;
    const acceptedEvt = view.timeline.find((e: any) => e.status === 'accepted');
    if (acceptedEvt) rec.acceptedAtMs = acceptedEvt.atMs;
    if (TERMINAL.has(view.status)) {
      const term = view.timeline.find((e: any) => TERMINAL.has(e.status));
      if (term) rec.terminalAtMs = term.atMs;
      rec.terminalCode = (view as any).terminalCode;
      if (view.status === 'completed') {
        try {
          const result = await client.getRunResult(rec.runId);
          rec.resultHash = (result as any).resultHash;
          rec.metrics = (result as any).metrics;
        } catch (err) {
          rec.error = (rec.error ? rec.error + '; ' : '') + `getRunResult failed: ${String((err as Error)?.message ?? err)}`;
        }
      }
      return;
    }
    if (Date.now() > deadline) {
      rec.error = (rec.error ? rec.error + '; ' : '') + `poll timeout after ${maxMs}ms, last status=${view.status}`;
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  console.log('=== registry sanity check ===');
  try {
    const registry = await client.discoverRegistry();
    console.log('registry ok, presets:', JSON.stringify((registry as any).overlayRunPresets?.map((p: any) => p.id)));
  } catch (err) {
    console.log('registry check failed (non-fatal for strategy engine path):', String((err as Error)?.message ?? err));
  }

  // 1+2. Control + concurrent identical burst ×4 (BEATUSDT) — fired TOGETHER via Promise.all so the
  // burst queues while the leader's (control's) ~15-40s engine is still in flight. This is what makes
  // the burst exercise COALESCING (waiting_for_compute -> wake -> hit) rather than a plain completed-
  // cache dedup hit: if control were awaited to terminal first, the cache would already be populated
  // and the burst would just be 4 more cache hits (no compute lock / wait involved at all).
  console.log('\n=== 1+2. CONTROL + BURST x4 (BEATUSDT, all 5 fired concurrently) ===');
  const [control, ...burstSubmits] = await Promise.all([
    submit('control', 'BEATUSDT'),
    submit('burst-1', 'BEATUSDT'),
    submit('burst-2', 'BEATUSDT'),
    submit('burst-3', 'BEATUSDT'),
    submit('burst-4', 'BEATUSDT'),
  ]);
  console.log('control runId:', control.runId, control.error ?? '');
  for (const b of burstSubmits) console.log(b.label, 'runId:', b.runId, b.error ?? '');
  await Promise.all([control, ...burstSubmits].map((r) => pollToTerminal(r)));
  console.log('control terminal:', control.status, control.terminalCode, control.resultHash?.slice(0, 14));
  results.push(control);
  for (const b of burstSubmits) {
    console.log(b.label, 'terminal:', b.status, b.terminalCode, b.resultHash?.slice(0, 14));
    results.push(b);
  }

  // 3. Post-completion repeat ×1 (BEATUSDT), submitted AFTER burst fully terminal
  console.log('\n=== 3. POST-COMPLETION REPEAT (BEATUSDT) ===');
  const repeat = await submit('repeat', 'BEATUSDT');
  console.log('repeat runId:', repeat.runId, repeat.error ?? '');
  await pollToTerminal(repeat);
  console.log('repeat terminal:', repeat.status, repeat.terminalCode, repeat.resultHash?.slice(0, 14));
  results.push(repeat);

  // 4. Distinct ×1 (ESPORTSUSDT)
  console.log('\n=== 4. DISTINCT (ESPORTSUSDT) ===');
  const distinct = await submit('distinct', 'ESPORTSUSDT');
  console.log('distinct runId:', distinct.runId, distinct.error ?? '');
  await pollToTerminal(distinct);
  console.log('distinct terminal:', distinct.status, distinct.terminalCode, distinct.resultHash?.slice(0, 14));
  results.push(distinct);

  writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  console.log('\n=== DONE. Results written to', OUT_PATH, '===');
}

main().catch((err) => {
  console.error('FATAL:', err);
  writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  process.exit(1);
});
