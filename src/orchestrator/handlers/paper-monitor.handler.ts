// src/orchestrator/handlers/paper-monitor.handler.ts
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { evaluatePaperWindow, resolveWindowPolicy } from '../../domain/paper-window.ts';
import { createAndEnqueueTask } from '../task-intake.ts';
import { event, errMsg } from './backtest-support.ts';

export const PaperMonitorPayloadSchema = z.object({
  experimentId: z.string().min(1),
  attempt: z.number().int().nonnegative().optional(),
  // Monitor-loop generation. A fresh paper.start revival opens a new epoch so its dedupeKeys
  // (paper.monitor:<exp>:<epoch>:<attempt>) never collide with — and are never dedup-swallowed
  // by — the original chain's already-created attempt keys.
  epoch: z.number().int().nonnegative().optional(),
});

/**
 * Self-rescheduling paper-observation monitor (§4 design). Locates the live paper run
 * (heuristic strategyName+time join, isolated behind PaperRunLocatorPort), polls its closed-trade
 * count via evaluatePaperWindow's adaptive policy, and — on window_complete — auto-triggers
 * Cycle 2 (research.run_cycle) exactly once per window (dedupeKey `paper_window:${runId}`).
 */
export const paperMonitorHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(PaperMonitorPayloadSchema, task.payload);
  if (parsed.status === 'invalid') throw new Error(`invalid paper.monitor payload: ${JSON.stringify(parsed.issues)}`);
  const { experimentId } = parsed.data;
  const attempt = parsed.data.attempt ?? 0;
  const epoch = parsed.data.epoch ?? 0;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const sub = await services.paperSubmissions.findByExperimentId(experimentId);
  if (!sub || sub.submissionStatus !== 'submitted') throw new Error(`paper.monitor: no submitted paper_submission for experiment ${experimentId}`);
  if (sub.monitorStatus === 'window_complete' || sub.monitorStatus === 'stalled') {
    await services.events.append(event(task.id, 'paper.monitor.already_done', { experimentId, monitorStatus: sub.monitorStatus }));
    return;
  }
  if (!sub.strategyName) throw new Error(`paper.monitor: paper_submission ${experimentId} has no strategyName — re-run paper.start (post-G4 version)`);

  const policy = resolveWindowPolicy(sub.windowPolicy, services.paperWindowPolicy);
  const submittedAtMs = Date.parse(sub.createdAt);

  const reschedule = async (): Promise<void> => {
    await createAndEnqueueTask(
      { taskType: 'paper.monitor', source: task.source, payload: { experimentId, attempt: attempt + 1, epoch },
        correlationId: task.correlationId, dedupeKey: `paper.monitor:${experimentId}:${epoch}:${attempt + 1}`,
        delayMs: services.paperMonitorPollMs },
      { repo: services.researchTasks, queue: services.taskQueue },
    );
  };

  let runId = sub.paperRunId;
  let runStartedAtMs = sub.runStartedAtMs;
  if (!runId) {
    // A transient platform error here must NOT fail the task: a failed paper.monitor is never
    // retried into attempt+1, so one hiccup would strand the submission at 'watching' for the
    // whole (multi-week) poll cadence. Reschedule the next tick and keep the chain alive.
    let located: Awaited<ReturnType<typeof services.paperRunLocator.locate>>;
    try {
      located = await services.paperRunLocator.locate({ strategyName: sub.strategyName, submittedAtMs });
    } catch (err) {
      await services.events.append(event(task.id, 'paper.monitor.poll_failed', { experimentId, attempt, phase: 'locate', error: errMsg(err) }));
      await reschedule();
      return;
    }
    if (!located) {
      if (now - submittedAtMs > policy.maxWaitDays * 24 * 3600 * 1000) {
        await services.paperSubmissions.updateMonitorState(experimentId, { monitorStatus: 'stalled', updatedAt: nowIso });
        await services.events.append(event(task.id, 'paper.run_not_found', { experimentId, strategyName: sub.strategyName }));
        return;
      }
      await reschedule();
      return;
    }
    runId = located.runId;
    runStartedAtMs = located.startedAtMs;
    await services.paperSubmissions.updateMonitorState(experimentId, { paperRunId: runId, runStartedAtMs, updatedAt: nowIso });
    await services.events.append(event(task.id, 'paper.run_located', { experimentId, runId }));
  }

  let summary: Awaited<ReturnType<typeof services.botResults.getRunSummary>>;
  try {
    summary = await services.botResults.getRunSummary(runId);
  } catch (err) {
    // Same transient-error guard as the locate() call above — reschedule, don't die.
    await services.events.append(event(task.id, 'paper.monitor.poll_failed', { experimentId, attempt, phase: 'summary', error: errMsg(err) }));
    await reschedule();
    return;
  }
  const verdict = evaluatePaperWindow(policy, { runStartedAtMs: runStartedAtMs ?? submittedAtMs, nowMs: now, closedTrades: summary.closedTrades });

  if (verdict.state === 'watching') {
    await services.paperSubmissions.updateMonitorState(experimentId, { observedTrades: summary.closedTrades, updatedAt: nowIso });
    await reschedule();
    return;
  }
  if (verdict.state === 'stalled') {
    await services.paperSubmissions.updateMonitorState(experimentId, { monitorStatus: 'stalled', observedTrades: summary.closedTrades, updatedAt: nowIso });
    await services.events.append(event(task.id, 'paper.window_stalled', { experimentId, runId, observedTrades: summary.closedTrades }));
    return;
  }
  await services.paperSubmissions.updateMonitorState(experimentId, {
    monitorStatus: 'window_complete', observedTrades: summary.closedTrades, lowConfidence: verdict.lowConfidence, updatedAt: nowIso,
  });
  await services.events.append(event(task.id, 'paper.window_complete', { experimentId, runId, closedTrades: summary.closedTrades, lowConfidence: verdict.lowConfidence }));
  await createAndEnqueueTask(
    { taskType: 'research.run_cycle', source: 'platform', payload: { strategyProfileId: sub.strategyProfileId, paperRunId: runId },
      correlationId: task.correlationId, dedupeKey: `paper_window:${runId}` },
    { repo: services.researchTasks, queue: services.taskQueue },
  );
};
