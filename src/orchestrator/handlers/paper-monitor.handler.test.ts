// src/orchestrator/handlers/paper-monitor.handler.test.ts
import { describe, it, expect } from 'vitest';
import { paperMonitorHandler, PaperMonitorPayloadSchema } from './paper-monitor.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask, QueueEnvelope } from '../../domain/types.ts';
import type { PaperSubmission } from '../../domain/paper-submission.ts';
import type { PaperRunLocatorPort } from '../../ports/paper-run-locator.port.ts';
import type { RunSummary } from '../../ports/bot-results-read.port.ts';

const DAY_MS = 24 * 3600 * 1000;

function taskOf(payload: Record<string, unknown>, over: Partial<ResearchTask> = {}): ResearchTask {
  const now = new Date().toISOString();
  return {
    id: 't-mon-1', taskType: 'paper.monitor', source: 'operator', correlationId: 'corr-1',
    status: 'running', payload, createdAt: now, updatedAt: now, ...over,
  };
}

function submissionRow(over: Partial<PaperSubmission> = {}): PaperSubmission {
  const now = new Date().toISOString();
  return {
    id: 'sub-1', experimentId: 'exp-wfo', strategyProfileId: 'prof-1',
    submissionStatus: 'submitted', idempotencyKey: 'wfo-champion:exp-wfo', bundleHash: 'sha256:x',
    strategyName: 'strategy-x', monitorStatus: 'watching', observedTrades: 0,
    createdAt: now, updatedAt: now, ...over,
  };
}

function runSummary(closedTrades: number, runId = 'run-live-1'): RunSummary {
  return {
    runId, excludesReconcile: true, asOf: Date.now(), closedTrades, wins: closedTrades, losses: 0,
    breakeven: 0, winratePct: 100, pnlUsd: '0', avgPnl: '0', exitReasons: {},
  };
}

interface Harness {
  services: AppServices;
  events: { type: string; payload: Record<string, unknown> }[];
  queueCalls: { envelope: QueueEnvelope; opts?: { delayMs?: number } }[];
  getRunSummaryCalls: string[];
}

function harness(opts: { locate?: PaperRunLocatorPort['locate']; runSummary?: RunSummary } = {}): Harness {
  const paperRunLocator: PaperRunLocatorPort = { locate: opts.locate ?? (async () => null) };
  const services = makeServices({ paperRunLocator });

  const getRunSummaryCalls: string[] = [];
  const originalGetRunSummary = services.botResults.getRunSummary.bind(services.botResults);
  services.botResults.getRunSummary = async (runId: string) => {
    getRunSummaryCalls.push(runId);
    return opts.runSummary ?? (await originalGetRunSummary(runId));
  };

  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const originalAppend = services.events.append.bind(services.events);
  services.events.append = async (evt) => {
    events.push({ type: evt.type, payload: evt.payload });
    return originalAppend(evt);
  };

  const queueCalls: { envelope: QueueEnvelope; opts?: { delayMs?: number } }[] = [];
  const originalEnqueue = services.taskQueue.enqueue.bind(services.taskQueue);
  services.taskQueue.enqueue = async (envelope, enqueueOpts) => {
    queueCalls.push({ envelope, opts: enqueueOpts });
    return originalEnqueue(envelope, enqueueOpts);
  };

  return { services, events, queueCalls, getRunSummaryCalls };
}

describe('paperMonitorHandler', () => {
  it('rejects an invalid payload', async () => {
    const { services } = harness();
    await expect(paperMonitorHandler(taskOf({}), services)).rejects.toThrow(/invalid paper\.monitor payload/);
  });

  it('missing strategyName on an otherwise-live row → actionable error', async () => {
    const { services } = harness();
    await services.paperSubmissions.upsertByExperimentId(submissionRow({ strategyName: undefined }));
    await expect(paperMonitorHandler(taskOf({ experimentId: 'exp-wfo' }), services)).rejects.toThrow(/no strategyName — re-run paper\.start/);
  });

  it('terminal row (already window_complete) → already_done event, no botResults call', async () => {
    const { services, events, getRunSummaryCalls } = harness();
    await services.paperSubmissions.upsertByExperimentId(submissionRow({ monitorStatus: 'window_complete' }));
    await paperMonitorHandler(taskOf({ experimentId: 'exp-wfo' }), services);
    expect(events).toContainEqual({ type: 'paper.monitor.already_done', payload: { experimentId: 'exp-wfo', monitorStatus: 'window_complete' } });
    expect(getRunSummaryCalls).toHaveLength(0);
  });

  it('run not yet located, within maxWaitDays → reschedules with attempt+1 dedupeKey + delayMs', async () => {
    const { services, queueCalls } = harness({ locate: async () => null });
    const createdAt = new Date(Date.now() - 1 * DAY_MS).toISOString();
    await services.paperSubmissions.upsertByExperimentId(submissionRow({ createdAt }));
    await paperMonitorHandler(taskOf({ experimentId: 'exp-wfo', attempt: 2 }, { source: 'operator' }), services);

    const monitorCalls = queueCalls.filter((c) => c.envelope.taskType === 'paper.monitor');
    expect(monitorCalls).toHaveLength(1);
    expect(monitorCalls[0]?.envelope.dedupeKey).toBe('paper.monitor:exp-wfo:3');
    expect(monitorCalls[0]?.envelope.source).toBe('operator');
    expect(monitorCalls[0]?.opts).toEqual({ delayMs: services.paperMonitorPollMs });
    const queuedTask = await services.researchTasks.findByDedupeKey('paper.monitor:exp-wfo:3');
    expect(queuedTask?.payload).toEqual({ experimentId: 'exp-wfo', attempt: 3 });
  });

  it('run located → ledger fixed with paperRunId/runStartedAtMs + paper.run_located event', async () => {
    const startedAtMs = Date.now();
    const { services, events } = harness({ locate: async () => ({ runId: 'run-live-9', startedAtMs }), runSummary: runSummary(0, 'run-live-9') });
    await services.paperSubmissions.upsertByExperimentId(submissionRow({}));
    await paperMonitorHandler(taskOf({ experimentId: 'exp-wfo' }), services);

    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({ paperRunId: 'run-live-9', runStartedAtMs: startedAtMs });
    expect(events).toContainEqual({ type: 'paper.run_located', payload: { experimentId: 'exp-wfo', runId: 'run-live-9' } });
  });

  it('watching (below minTrades, within window) → observedTrades updated + reschedule', async () => {
    const runStartedAtMs = Date.now() - 10 * DAY_MS; // within [minDays=3, maxDays=30)
    const { services, queueCalls } = harness({ runSummary: runSummary(5, 'run-live-2') });
    await services.paperSubmissions.upsertByExperimentId(submissionRow({ paperRunId: 'run-live-2', runStartedAtMs }));
    await paperMonitorHandler(taskOf({ experimentId: 'exp-wfo' }), services);

    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row?.observedTrades).toBe(5);
    expect(row?.monitorStatus).toBe('watching');
    const monitorCalls = queueCalls.filter((c) => c.envelope.taskType === 'paper.monitor');
    expect(monitorCalls).toHaveLength(1);
    expect(monitorCalls[0]?.envelope.dedupeKey).toBe('paper.monitor:exp-wfo:1');
  });

  it('window_complete (>=minTrades, elapsed>=minDays) → ledger+event+research.run_cycle enqueued exactly once; a second monitor run → already_done, no duplicate enqueue', async () => {
    const runStartedAtMs = Date.now() - 10 * DAY_MS;
    const { services, events, queueCalls } = harness({ runSummary: runSummary(30, 'run-live-3') });
    await services.paperSubmissions.upsertByExperimentId(submissionRow({ paperRunId: 'run-live-3', runStartedAtMs, strategyProfileId: 'prof-1' }));

    await paperMonitorHandler(taskOf({ experimentId: 'exp-wfo' }, { correlationId: 'corr-9' }), services);

    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({ monitorStatus: 'window_complete', observedTrades: 30, lowConfidence: false });
    expect(events).toContainEqual({
      type: 'paper.window_complete',
      payload: { experimentId: 'exp-wfo', runId: 'run-live-3', closedTrades: 30, lowConfidence: false },
    });
    const cycleCalls = queueCalls.filter((c) => c.envelope.taskType === 'research.run_cycle');
    expect(cycleCalls).toHaveLength(1);
    expect(cycleCalls[0]?.envelope.dedupeKey).toBe('paper_window:run-live-3');
    expect(cycleCalls[0]?.envelope.source).toBe('platform');
    expect(cycleCalls[0]?.envelope.correlationId).toBe('corr-9');
    const queuedCycleTask = await services.researchTasks.findByDedupeKey('paper_window:run-live-3');
    expect(queuedCycleTask?.payload).toEqual({ strategyProfileId: 'prof-1', paperRunId: 'run-live-3' });

    // Second monitor run on the now-terminal row: already_done, no duplicate research.run_cycle enqueue.
    await paperMonitorHandler(taskOf({ experimentId: 'exp-wfo' }), services);
    expect(events).toContainEqual({ type: 'paper.monitor.already_done', payload: { experimentId: 'exp-wfo', monitorStatus: 'window_complete' } });
    expect(queueCalls.filter((c) => c.envelope.taskType === 'research.run_cycle')).toHaveLength(1);
  });

  it('stalled at maxDays (elapsed>=maxDays, closedTrades<lowConfidenceThreshold) → ledger+event, no Cycle 2 trigger', async () => {
    const runStartedAtMs = Date.now() - 31 * DAY_MS; // past maxDays=30
    const { services, events, queueCalls } = harness({ runSummary: runSummary(5, 'run-live-4') });
    await services.paperSubmissions.upsertByExperimentId(submissionRow({ paperRunId: 'run-live-4', runStartedAtMs }));
    await paperMonitorHandler(taskOf({ experimentId: 'exp-wfo' }), services);

    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row).toMatchObject({ monitorStatus: 'stalled', observedTrades: 5 });
    expect(events).toContainEqual({
      type: 'paper.window_stalled',
      payload: { experimentId: 'exp-wfo', runId: 'run-live-4', observedTrades: 5 },
    });
    expect(queueCalls.filter((c) => c.envelope.taskType === 'research.run_cycle')).toHaveLength(0);
  });

  it('maxWaitDays exceeded with no located run → stalled + paper.run_not_found, no reschedule', async () => {
    const createdAt = new Date(Date.now() - 8 * DAY_MS).toISOString(); // past maxWaitDays=7
    const { services, events, queueCalls } = harness({ locate: async () => null });
    await services.paperSubmissions.upsertByExperimentId(submissionRow({ createdAt }));
    await paperMonitorHandler(taskOf({ experimentId: 'exp-wfo' }), services);

    const row = await services.paperSubmissions.findByExperimentId('exp-wfo');
    expect(row?.monitorStatus).toBe('stalled');
    expect(events).toContainEqual({
      type: 'paper.run_not_found',
      payload: { experimentId: 'exp-wfo', strategyName: 'strategy-x' },
    });
    expect(queueCalls.filter((c) => c.envelope.taskType === 'paper.monitor')).toHaveLength(0);
  });
});

void PaperMonitorPayloadSchema;
