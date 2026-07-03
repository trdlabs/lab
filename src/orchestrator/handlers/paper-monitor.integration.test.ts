// src/orchestrator/handlers/paper-monitor.integration.test.ts
//
// End-to-end integration test for the paper.monitor chain (slice G4, spec §7 test 9): a
// submitted+watching paper_submission ledger row + a fake bot-results/locator pair standing in
// for the platform ops-read boundary (real HTTP is out of scope here — this proves the lab-side
// wiring, per the design doc's "tolerant monitor" acceptance: lab-side G4 is verified on
// fake/fixture ops-read). Composition style mirrors paper-bridge.integration.test.ts: real
// in-memory services via makeServices(), only the platform-facing edges (paperRunLocator,
// botResults.getRunSummary) are capturing fakes.
import { describe, it, expect } from 'vitest';
import { paperMonitorHandler } from './paper-monitor.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { PaperSubmission } from '../../domain/paper-submission.ts';
import type { PaperRunLocatorPort } from '../../ports/paper-run-locator.port.ts';
import type { RunSummary } from '../../ports/bot-results-read.port.ts';

const NOW = Date.now();
const DAY_MS = 24 * 3600 * 1000;

function taskOf(payload: Record<string, unknown>): ResearchTask {
  const now = new Date().toISOString();
  return {
    id: 't-mon-int-1', taskType: 'paper.monitor', source: 'platform', correlationId: 'corr-int-1',
    status: 'running', payload, createdAt: now, updatedAt: now,
  };
}

describe('paper.monitor integration (paperMonitorHandler, end-to-end on in-memory infra)', () => {
  it('watching ledger row + a located paper run with >=minTrades closed trades -> window_complete + research.run_cycle enqueued', async () => {
    // --- capturing fakes: the only non-real edges (platform ops-read boundary) ---
    const LOCATED_RUN_ID = 'run-live-int-1';
    const RUN_STARTED_AT_MS = NOW - 10 * DAY_MS; // > minDays(3) ago, well under maxDays(30)
    const SUBMITTED_AT_MS = NOW - 11 * DAY_MS;

    const paperRunLocator: PaperRunLocatorPort = {
      locate: async (args) => {
        expect(args.strategyName).toBe('long_oi-int');
        return { runId: LOCATED_RUN_ID, startedAtMs: RUN_STARTED_AT_MS };
      },
    };
    const services = makeServices({ paperRunLocator });

    const runSummary: RunSummary = {
      runId: LOCATED_RUN_ID, excludesReconcile: true, asOf: NOW, closedTrades: 42, wins: 30, losses: 12,
      breakeven: 0, winratePct: 71.4, pnlUsd: '1234.56', avgPnl: '29.4', exitReasons: {},
    };
    const originalGetRunSummary = services.botResults.getRunSummary.bind(services.botResults);
    services.botResults.getRunSummary = async (runId: string) => {
      if (runId === LOCATED_RUN_ID) return runSummary;
      return originalGetRunSummary(runId);
    };

    // --- seed: submitted + watching ledger row (strategy_name set, as paperStartHandler seeds it) ---
    const submissionRow: PaperSubmission = {
      id: 'sub-int-1', experimentId: 'exp-int-wfo', strategyProfileId: 'prof-int-1',
      submissionStatus: 'submitted', idempotencyKey: 'wfo-champion:exp-int-wfo', bundleHash: 'sha256:int',
      strategyName: 'long_oi-int', monitorStatus: 'watching', observedTrades: 0,
      windowPolicy: services.paperWindowPolicy as unknown as Record<string, unknown>,
      createdAt: new Date(SUBMITTED_AT_MS).toISOString(), updatedAt: new Date(SUBMITTED_AT_MS).toISOString(),
    };
    await services.paperSubmissions.upsertByExperimentId(submissionRow);

    // Sanity: the row is genuinely watching before the monitor tick runs.
    const watchingBefore = await services.paperSubmissions.listWatching();
    expect(watchingBefore.map((r) => r.experimentId)).toContain('exp-int-wfo');

    // --- run the monitor handler (real event/queue/repo services underneath) ---
    await paperMonitorHandler(taskOf({ experimentId: 'exp-int-wfo' }), services);

    // --- ledger: window_complete, normal confidence, observedTrades reflects the summary ---
    const row = await services.paperSubmissions.findByExperimentId('exp-int-wfo');
    expect(row).toMatchObject({
      monitorStatus: 'window_complete', observedTrades: 42, lowConfidence: false,
      paperRunId: LOCATED_RUN_ID, runStartedAtMs: RUN_STARTED_AT_MS,
    });

    // Row no longer shows up as watching once the window completes.
    const watchingAfter = await services.paperSubmissions.listWatching();
    expect(watchingAfter.map((r) => r.experimentId)).not.toContain('exp-int-wfo');

    // --- research.run_cycle task created with {strategyProfileId, paperRunId}, found via its dedupeKey ---
    const cycleTask = await services.researchTasks.findByDedupeKey(`paper_window:${LOCATED_RUN_ID}`);
    expect(cycleTask).toBeTruthy();
    expect(cycleTask?.taskType).toBe('research.run_cycle');
    expect(cycleTask?.source).toBe('platform');
    expect(cycleTask?.payload).toEqual({ strategyProfileId: 'prof-int-1', paperRunId: LOCATED_RUN_ID });
  });
});
