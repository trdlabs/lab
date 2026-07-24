// src/orchestrator/handlers/hypothesis-holdout.handler.ts
//
// R12a (research-validation-hardening item 5a): the `hypothesis.holdout` task — a lightweight,
// LOG-ONLY holdout confirmation of the proxy `PAPER_CANDIDATE` verdict. Enqueued from the
// PAPER_CANDIDATE branch of `backtest-completed.handler.ts` ONLY when `LAB_HYPOTHESIS_HOLDOUT=log`.
//
// It reconstructs the exact bundle the PAPER_CANDIDATE run used, resolves a holdout window from the
// SAME source `runNewStrategyValidation` uses (`resolveHoldoutBoundary` over the run's real trades +
// full period + `DEFAULT_HOLDOUT_POLICY`, then `encodeHoldoutPeriod([T, to])`), submits ONE
// single-fold overlay run on that window (no WFO ladder, no grid), feeds `runBreakBattery` (R11),
// persists the full report onto the hypothesis and emits STRUCTURAL events. It NEVER mutates any
// hypothesis status/verdict, never enqueues a retry, and never emits observed magnitudes in events.
//
// Every failure path is fail-soft: it appends a diagnostic event and resolves successfully. A
// missing baseline / window / bundle is a `skipped` (an expected non-runnable state, skip != fail);
// an unexpected throw / non-completed run is a `failed` — both resolve without failing the task.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { event, errMsg } from './backtest-support.ts';
import { PlatformRunConfigSchema } from './platform-run-config.schema.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { PlatformRunConfig, SubmitOverlayRunOptions } from '../../ports/research-platform.port.ts';
import { runOverlayBacktest } from '../../research/run-backtest.ts';
import { resolveHoldoutBoundary } from '../../research/holdout-boundary-resolver.ts';
import { encodeHoldoutPeriod } from '../../research/period-encoding.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../../domain/research-experiment.ts';
import { hypothesisFamilyHint } from '../../research/hypothesis-family.ts';
import { runBreakBattery, type BreakBatteryInput } from '../../research/break-battery.ts';
import { computeOosDegradation } from '../../validation/strategy-baseline-evaluator.ts';
import { mapPlatformComparison } from '../../domain/platform-comparison.ts';

export const HypothesisHoldoutPayloadSchema = z.object({
  hypothesisId: z.string().min(1),
  strategyProfileId: z.string().min(1),
  backtestRunId: z.string().min(1),
  /** Advisory recoverability signal only — its PRESENCE (together with, or instead of, the run's
   *  stored metrics) decides whether an IS baseline exists at all (the recoverability gate below).
   *  It is NEVER itself fed into the degradation ratio: `computeOosDegradation` always reads the
   *  stored full-period metric block (`run.metrics`), never this field. Consequently the
   *  isSharpe-only path (hint present, `run.metrics` absent) still runs the battery, but with the
   *  OOS-degradation check reporting `skipped` (non-breaking) rather than an evaluated ratio. */
  isSharpe: z.number().optional(),
  /** The window the PAPER_CANDIDATE run executed on; the holdout-window fallback when the persisted
   *  run row has no `platformRun`. */
  evalPlatformRun: PlatformRunConfigSchema.optional(),
});
export type HypothesisHoldoutPayload = z.infer<typeof HypothesisHoldoutPayloadSchema>;

export const hypothesisHoldoutHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(HypothesisHoldoutPayloadSchema, task.payload);
  if (parsed.status === 'invalid') {
    throw new Error(`invalid hypothesis.holdout payload: ${JSON.stringify(parsed.issues)}`);
  }
  const { hypothesisId, strategyProfileId, backtestRunId, isSharpe, evalPlatformRun } = parsed.data;

  await services.events.append(event(task.id, 'hypothesis.holdout.started', {
    hypothesisId, strategyProfileId, backtestRunId,
  }));

  const skip = async (reason: string): Promise<void> => {
    await services.events.append(event(task.id, 'hypothesis.holdout.skipped', { hypothesisId, backtestRunId, reason }));
  };
  const fail = async (reason: string, detail?: string): Promise<void> => {
    await services.events.append(event(task.id, 'hypothesis.holdout.failed', {
      hypothesisId, backtestRunId, reason, ...(detail !== undefined ? { error: detail } : {}),
    }));
  };

  try {
    const run = await services.backtests.findById(backtestRunId);
    if (!run) { await skip('backtest_run_unavailable'); return; }

    // IS baseline recoverability gate (§3): need EITHER the run's stored full-period metric block
    // OR an explicit `isSharpe` hint. Neither → skip (skip != fail; missing baseline is not a bug).
    const isMetrics = run.metrics ?? undefined;
    if (isMetrics === undefined && isSharpe === undefined) { await skip('is_baseline_unavailable'); return; }

    // Holdout window from the SAME source runNewStrategyValidation uses.
    const fullRun = run.platformRun ?? evalPlatformRun;
    if (!fullRun) { await skip('holdout_window_unavailable'); return; }
    const trades = await services.runTrades.getRunTrades(run.platformRunId);
    const boundary = resolveHoldoutBoundary(trades, fullRun.period, DEFAULT_HOLDOUT_POLICY);
    if (boundary.mode === 'none' || !boundary.t) { await skip('holdout_window_unavailable'); return; }
    const holdoutPeriod = encodeHoldoutPeriod(boundary.t, fullRun.period.to);

    // Reconstruct the exact bundle the PAPER_CANDIDATE run used.
    const build = await services.builds.findById(run.hypothesisBuildId);
    if (!build?.bundleArtifactRef) { await skip('bundle_unavailable'); return; }
    const bundleBuf = await services.artifacts.get(build.bundleArtifactRef);
    const bundle = JSON.parse(bundleBuf.toString()) as ModuleBundle;
    const baselineRef = { id: run.baselineModuleId, version: services.baselineVersion };

    // R12b: the holdout run joins the SAME trial-ledger family as every other trial of this hypothesis.
    const hypothesis = await services.hypotheses.findById(hypothesisId);
    const trialFamilyHint = hypothesis ? hypothesisFamilyHint(hypothesis) : undefined;

    // ONE single-fold holdout run of the same bundle on [T, to] — no ladder, no grid.
    const holdoutRun: PlatformRunConfig = {
      datasetId: fullRun.datasetId, symbols: [...fullRun.symbols], timeframe: fullRun.timeframe,
      seed: fullRun.seed, period: holdoutPeriod,
    };
    const opts: SubmitOverlayRunOptions = {
      target: services.researchIntegration === 'backtester'
        ? { kind: 'registry_preset' }
        : { kind: 'baseline_ref', moduleRef: baselineRef },
      run: holdoutRun,
      correlationId: task.correlationId,
      ...(trialFamilyHint !== undefined ? { trialFamilyHint } : {}),
    };
    const outcome = await runOverlayBacktest(services.researchPlatform, bundle, opts, {
      maxPolls: services.platformPoll.maxPolls, pollDelayMs: services.platformPoll.pollDelayMs,
    });
    if (outcome.status !== 'completed') { await fail(`holdout_run_${outcome.status}`); return; }

    const holdoutComparison = mapPlatformComparison(outcome.summary);

    // BreakBatteryInput: trialContext spread-if-present, oosDegradation from IS/OOS metric blocks,
    // plateau OMITTED (no grid at the hypothesis level → the plateau check reports `skipped`, which
    // the battery already treats as non-breaking).
    const batteryInput: BreakBatteryInput = {
      ...(outcome.summary.trialContext !== undefined ? { trialContext: outcome.summary.trialContext } : {}),
      oosDegradation: computeOosDegradation(isMetrics, holdoutComparison.variant),
    };
    const report = runBreakBattery(batteryInput);

    // Persistence lane: the FULL report (with observed magnitudes) lands on the hypothesis record —
    // Outcome Embargo never scrubs deterministic persistence, only event/generation-lane egress.
    // Fail-soft: a persistence problem must not fail the log-only task.
    try {
      await services.hypotheses.recordHoldoutBattery(hypothesisId, report);
    } catch (err) {
      await services.events.append(event(task.id, 'hypothesis.holdout.persist_failed', { hypothesisId, error: errMsg(err) }));
    }

    // STRUCTURAL event ONLY: outcome + canonical `break_battery.*` failure codes — never observed
    // magnitudes (mirrors R11's `break_battery.completed` event shape).
    await services.events.append(event(task.id, 'hypothesis.holdout.completed', {
      hypothesisId, backtestRunId, outcome: report.outcome, failedReasonCodes: report.failedReasonCodes,
    }));
  } catch (err) {
    // §6: ANY unexpected throw (submit / poll / mapping / battery) is fail-soft with a diagnostic event.
    await fail('unexpected_error', errMsg(err));
  }
};
