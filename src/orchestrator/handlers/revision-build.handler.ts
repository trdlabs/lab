import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler, HandlerDeps } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { event, errMsg, stableStringify } from './backtest-support.ts';
import type { ResearchTask } from '../../domain/types.ts';
import { createAndEnqueueTask } from '../task-intake.ts';
import { isCycleChainTerminal, CYCLE_CLOSE_MAX_WAIT_ATTEMPTS, CYCLE_CLOSE_WAIT_DELAY_MS } from '../cycle-close.ts';
import type { DroppedHypothesis, HoldoutValidation, StrategyRevision } from '../../domain/strategy-revision.ts';
import type { HypothesisProposal, HypothesisStatus, RuleAction } from '../../domain/hypothesis.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { sortEligible } from '../../research/hypothesis-score.ts';
import { detectConflicts } from '../../research/rule-conflict.ts';
import { composeRevisionBundle, type OverlayModuleInput } from '../../research/compose-revision-bundle.ts';
import { reconstructStrategyBundle } from '../../research/reconstruct-strategy-bundle.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';
import { validateStrategyBundle } from '../../validation/strategy-bundle-validator.ts';
import { computeStrategyParamsHash } from '../../research/strategy-run-identity.ts';
import { RESEARCH_RUN_METRICS } from '../../domain/platform-comparison.ts';
import type { StrategyManifestMeta } from '../../ports/strategy-builder.port.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { RevisionRunResult } from '../../ports/strategy-revision-run-executor.ts';
import { evaluateRevision, DEFAULT_REVISION_EVALUATOR_POLICY, type RevisionVerdict } from '../../validation/revision-evaluator.ts';
import { applyRevisionPreservationGate } from '../../validation/apply-preservation-gate.ts';
import type { PreservationMetadata } from '../../validation/trade-preservation.ts';
import type { TradeRecord, HoldoutBoundary } from '../../domain/research-experiment.ts';
import { resolveHoldoutBoundary } from '../../research/holdout-boundary-resolver.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../../domain/research-experiment.ts';
import { encodeTrainPeriod, encodeHoldoutPeriod } from '../../research/period-encoding.ts';
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';

export const RevisionBuildPayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  correlationId: z.string().min(1),
  waitAttempt: z.number().int().nonnegative().optional(),
});

/** Max additional candidate runs after the first (spec: max 2 retries, <= 3 candidate runs total). */
const MAX_RETRIES = 2;

const now = (): string => new Date().toISOString();

/**
 * Step 1 backfill: bootstraps strategy_revision v1 from the latest completed
 * strategy_baseline_validation experiment for the profile — mirrors Task 8's
 * ExperimentService.bootstrapRevisionV1 shape exactly. Fail-soft: any error emits
 * `revision.bootstrap_failed` and returns null (caller falls through to the
 * `no_baseline` skip path); never throws.
 */
async function bootstrapFromBaseline(
  task: ResearchTask,
  services: HandlerDeps,
  strategyProfileId: string,
): Promise<StrategyRevision | null> {
  try {
    const baselines = await services.experiments.listByType('strategy_baseline_validation');
    const candidates = baselines
      .filter((e) => e.strategyProfileId === strategyProfileId && e.status === 'completed' && e.bundleArtifactRef !== undefined)
      .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt));
    const baseline = candidates[0];
    if (!baseline || !baseline.bundleArtifactRef) return null;

    const members = await services.experiments.listMembers(baseline.id);
    const comboMember = members.find((m) => m.role === 'holdout') ?? members.find((m) => m.role === 'sanity');
    const comboBacktestRunId = comboMember?.strategyBacktestRunId;
    if (!comboBacktestRunId) return null;

    const run = await services.strategyBacktests.findById(comboBacktestRunId);
    const ts = now();
    const revision: StrategyRevision = {
      id: randomUUID(), strategyProfileId, version: 1,
      hypothesisIds: [], mergedRuleSet: { order: [], rules: [] }, status: 'accepted',
      bundleArtifactRef: baseline.bundleArtifactRef, comboBacktestRunId,
      kind: 'composed', compositionDepth: 1, semanticParentRevisionId: undefined,
      ...(baseline.bundleHash !== undefined ? { bundleHash: baseline.bundleHash } : {}),
      ...(run?.metrics ? { metrics: run.metrics as unknown as Record<string, unknown> } : {}),
      createdAt: ts, updatedAt: ts,
    };
    await services.revisions.create(revision);
    return revision;
  } catch (err) {
    try {
      await services.events.append(event(task.id, 'revision.bootstrap_failed', {
        strategyProfileId, error: errMsg(err),
      }));
    } catch {
      /* swallow event append failure — must not compound the original failure */
    }
    return null;
  }
}

interface LoadedOverlays {
  overlays: OverlayModuleInput[];
  ruleActions: Record<string, RuleAction>;
  theses: Record<string, string>;
  loadDropped: DroppedHypothesis[];
}

/**
 * Step 4 artifact linkage. There is no direct field from a HypothesisProposal to its build's
 * artifact ref, but `HypothesisBuildRepository.listByHypothesis` already provides that link
 * indirectly — no schema change needed (see task-9-report.md for the documented decision).
 * Picks the most recently created build carrying a bundleArtifactRef + manifest (regardless of
 * status: a build that reached backtest.completed is typically 'submitted', not 'candidate').
 * The module's entry-file source is `files[manifest.entry]` per the ModuleBundle/BuilderOutput
 * shape hypothesisBuildHandler persists.
 */
async function loadOverlayInputs(services: HandlerDeps, kept: readonly HypothesisProposal[]): Promise<LoadedOverlays> {
  const overlays: OverlayModuleInput[] = [];
  const ruleActions: Record<string, RuleAction> = {};
  const theses: Record<string, string> = {};
  const loadDropped: DroppedHypothesis[] = [];

  for (const p of kept) {
    const builds = await services.builds.listByHypothesis(p.id);
    const candidate = builds
      .filter((b) => b.bundleArtifactRef !== null && b.manifest !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!candidate || !candidate.bundleArtifactRef || !candidate.manifest) {
      loadDropped.push({ hypothesisId: p.id, reason: 'unsupported_module_shape', detail: 'no build artifact found for hypothesis' });
      continue;
    }

    let moduleBundle: ModuleBundle;
    try {
      const raw = (await services.artifacts.get(candidate.bundleArtifactRef)).toString('utf8');
      moduleBundle = JSON.parse(raw) as ModuleBundle;
    } catch (err) {
      loadDropped.push({ hypothesisId: p.id, reason: 'unsupported_module_shape', detail: `failed to load build artifact: ${errMsg(err)}` });
      continue;
    }

    const entry = moduleBundle.manifest?.entry;
    const source = entry ? moduleBundle.files?.[entry] : undefined;
    if (!source) {
      loadDropped.push({ hypothesisId: p.id, reason: 'unsupported_module_shape', detail: 'module bundle missing entry file source' });
      continue;
    }

    overlays.push({ hypothesisId: p.id, source });
    ruleActions[p.id] = p.ruleAction;
    theses[p.id] = p.thesis;
  }

  return { overlays, ruleActions, theses, loadDropped };
}

/** Persists the composed+assembled strategy bundle as the `{source, manifest, bundleHash}`
 * wrapper artifact `reconstructStrategyBundle` expects — mirrors strategy-baseline.handler.ts. */
async function putBundleWrapper(services: HandlerDeps, bundle: AssembledStrategyBundle) {
  return services.artifacts.put(
    JSON.stringify({ source: bundle.source, manifest: bundle.manifest, bundleHash: bundle.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'revision-build-handler' },
  );
}

export const revisionBuildHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(RevisionBuildPayloadSchema, task.payload);
  if (parsed.status === 'invalid') {
    throw new Error(`invalid revision.build payload: ${JSON.stringify(parsed.issues)}`);
  }
  const { strategyProfileId, correlationId } = parsed.data;

  // --- Step 0: chain-terminality gate over settled chain-type rows (P0-1/P0-2) ---
  // The trigger (enqueueCycleClose) is enqueued unconditionally from any chain member's terminal
  // exit; the decision is made HERE, over settled statuses, because revision.build runs as its own
  // later task. This defeats the P0-1 status-race and the P0-2 non-backtest terminal exit. NOTE it
  // reads only settled CHAIN-TYPE rows — it does NOT wait on an async backtest still in-flight (no
  // backtest.completed row yet; resume routes via backtest.resume, not a chain type). Pre-existing
  // gap, fine on the synchronous path; see cycle-close.ts / spec §8.2 before raising concurrency on
  // the async path. Not-yet-terminal -> bounded delayed self-requeue; cap -> abandoned.
  if (!(await isCycleChainTerminal(correlationId, services))) {
    const waitAttempt = parsed.data.waitAttempt ?? 0;
    if (waitAttempt >= CYCLE_CLOSE_MAX_WAIT_ATTEMPTS) {
      await services.events.append(event(task.id, 'revision.build.abandoned', { correlationId, waitAttempt }));
      return;
    }
    const next = waitAttempt + 1;
    await createAndEnqueueTask(
      {
        taskType: 'revision.build', source: task.source,
        payload: { strategyProfileId, correlationId, waitAttempt: next },
        correlationId, dedupeKey: `revision.build:${correlationId}:wait${next}`,
        delayMs: CYCLE_CLOSE_WAIT_DELAY_MS,
      },
      { repo: services.researchTasks, queue: services.taskQueue },
    );
    await services.events.append(event(task.id, 'revision.build.deferred', { correlationId, waitAttempt: next }));
    return;
  }

  // --- Step 1: ensure an accepted revision exists (bootstrap-backfill if not) ---
  let accepted = await services.revisions.findLatestAccepted(strategyProfileId);
  if (!accepted) {
    accepted = await bootstrapFromBaseline(task, services, strategyProfileId);
  }
  if (!accepted || !accepted.bundleArtifactRef) {
    await services.events.append(event(task.id, 'revision.skipped', { strategyProfileId, reason: 'no_baseline' }));
    return;
  }

  // --- Step 2: collect eligible hypotheses, score-ordered, capped ---
  // Cycle-scope: listByStrategyProfile sweeps EVERY proxy_passed/proxy_paper_candidate
  // hypothesis of the profile, including ones from other (foreign/old) active research cycles —
  // that breaks the spec's batch invariant ("hypotheses of a cycle -> one candidate revision")
  // via cross-cycle contamination. Scope down to hypotheses whose hypothesis.build task row
  // (created by research-run-cycle.handler.ts, payload.hypothesisId) lives in THIS triggering
  // correlationId chain — the same chain backtest-completed.handler.ts waited on to go terminal
  // before enqueueing this revision.build.
  const cycleTasks = await services.researchTasks.listByCorrelationAndTypes(correlationId, ['hypothesis.build']);
  const cycleHypothesisIds = new Set(
    cycleTasks
      .map((t) => t.payload.hypothesisId)
      .filter((id): id is string => typeof id === 'string'),
  );
  const proposals = (await services.hypotheses.listByStrategyProfile(strategyProfileId))
    .filter((p) => cycleHypothesisIds.has(p.id));
  const eligible = sortEligible(proposals).slice(0, services.revisionBatchMax);
  if (eligible.length === 0) {
    await services.events.append(event(task.id, 'revision.skipped', { strategyProfileId, reason: 'no_eligible_hypotheses' }));
    return;
  }

  // --- Step 3: conflict detection ---
  // Hypothesis-status writes (dropped_merge_conflict / dropped_unsupported_shape) computed in
  // steps 3, 4 and 6 are STAGED, not applied yet — applying them here, before the candidate
  // revision row exists, would strand hypotheses in a dropped_* status with no revision row
  // explaining it if revisions.create() below hits a UNIQUE(strategyProfileId, version) race
  // (concurrent revision.build for the same profile). They are flushed only once the row is
  // durably created (Step 7); their revision.hypothesis_dropped events move with them —
  // deliberately, so the ledger never records a drop that didn't actually happen.
  const { kept, conflicts } = detectConflicts(eligible);
  const dropped: DroppedHypothesis[] = [];
  const pendingStatusWrites: Array<{ hypothesisId: string; status: HypothesisStatus }> = [];
  for (const c of conflicts) {
    pendingStatusWrites.push({ hypothesisId: c.loserId, status: 'dropped_merge_conflict' });
    dropped.push({ hypothesisId: c.loserId, reason: 'merge_conflict_dropped', detail: c.detail });
  }

  // --- Step 4: load each surviving hypothesis's overlay module source ---
  const { overlays, ruleActions, theses, loadDropped } = await loadOverlayInputs(services, kept);
  for (const d of loadDropped) {
    pendingStatusWrites.push({ hypothesisId: d.hypothesisId, status: 'dropped_unsupported_shape' });
    dropped.push(d);
  }

  // --- Step 5: base bundle = accepted revision's composed bundle ---
  const baseBundle = await reconstructStrategyBundle(services.artifacts, accepted.bundleArtifactRef);

  // --- Step 6: compose ---
  // Allocate the next version as max(version)+1 across ALL statuses, not accepted.version+1: a
  // rejected candidate — or a candidate stranded by a prior crashed attempt — occupies a version
  // number, and reusing accepted.version+1 would collide on UNIQUE(profileId, version), get caught
  // below as 'concurrent_revision', and wedge the profile's lane permanently (P0-3). max+1 is
  // collision-free under per-profile serialization (LAB_QUEUE_CONCURRENCY=1); the create() catch
  // below remains the backstop for a genuine concurrent build once that serialization is relaxed.
  const version = (await services.revisions.findMaxVersion(strategyProfileId)) + 1;
  let compose = composeRevisionBundle({
    baseSource: baseBundle.source,
    baseManifestMeta: baseBundle.manifest as StrategyManifestMeta,
    overlays, ruleActions, revisionVersion: version, theses,
  });
  for (const u of compose.unsupported) {
    pendingStatusWrites.push({ hypothesisId: u.hypothesisId, status: 'dropped_unsupported_shape' });
    dropped.push({ hypothesisId: u.hypothesisId, reason: 'unsupported_module_shape', detail: u.detail });
  }
  if (compose.included.length === 0) {
    // follow-up: with cycle-scoping (Step 2), an unsupported-only cycle leaves its hypotheses
    // stuck in proxy_* here — they will NOT be swept by a future cycle's scoped build, since that
    // future build only looks at ITS OWN correlationId's hypothesis.build tasks. A future slice
    // should either transition these hypotheses to a terminal dropped_* status here, or record a
    // rejected revision row referencing them, so they don't accumulate as orphaned proxy_*
    // forever. Deliberately not implemented in this fix — user-acknowledged trade-off.
    await services.events.append(event(task.id, 'revision.skipped', { strategyProfileId, reason: 'nothing_composable' }));
    return;
  }

  // --- Step 7: assemble, validate, persist candidate bundle + revision row ---
  let assembled = await assembleStrategyBundle(compose.output);
  const initialValidation = validateStrategyBundle(assembled);
  if (initialValidation.status === 'rejected') {
    await services.events.append(event(task.id, 'revision.skipped', {
      strategyProfileId, reason: 'bundle_invalid', violations: initialValidation.violations,
    }));
    return;
  }
  let bundleArtifactRef = await putBundleWrapper(services, assembled);

  const revisionId = randomUUID();
  const revision: StrategyRevision = {
    id: revisionId, strategyProfileId, version, baseRevisionId: accepted.id,
    hypothesisIds: [...compose.included], dropped: [...dropped], mergedRuleSet: compose.mergedRuleSet,
    bundleArtifactRef, bundleHash: assembled.bundleHash, status: 'candidate',
    kind: 'composed', compositionDepth: (accepted.compositionDepth ?? 1) + 1, semanticParentRevisionId: accepted.id,
    createdAt: now(), updatedAt: now(),
  };
  // Guarded: create() can throw on a UNIQUE(strategyProfileId, version) race with a concurrent
  // revision.build. If it does, the candidate row never existed, so none of the staged
  // hypothesis-status writes above may be committed either — bail out untouched instead of
  // stranding those hypotheses in a dropped_* status nothing explains.
  try {
    await services.revisions.create(revision);
  } catch (err) {
    await services.events.append(event(task.id, 'revision.skipped', {
      strategyProfileId, reason: 'concurrent_revision', detail: errMsg(err),
    }));
    return;
  }

  // The row now durably exists — safe to commit the staged hypothesis-status writes and their
  // revision.hypothesis_dropped events (see the Step 3 comment for why these were deferred).
  for (const w of pendingStatusWrites) {
    await services.hypotheses.updateStatus(w.hypothesisId, w.status);
  }
  for (const d of dropped) {
    await services.events.append(event(task.id, 'revision.hypothesis_dropped', {
      hypothesisId: d.hypothesisId, reason: d.reason, detail: d.detail,
    }));
  }

  await services.events.append(event(task.id, 'revision.candidate_built', {
    revisionId, version, included: compose.included, dropped,
  }));

  // --- Step 8: same-run-context comparison baseline (>= 0, <= 1 run) ---
  // R3b-1: the eval window is the cycle's — extracted from the hypothesis.build tasks, never
  // re-resolved here. If the cycle's tasks disagree, reject rather than silently mix windows.
  const cycleWindows = cycleTasks
    .map((t) => t.payload.platformRun as PlatformRunConfig | undefined)
    .filter((w): w is PlatformRunConfig => w !== undefined);
  const distinct = new Map(cycleWindows.map((w) => [stableStringify(w), w]));
  let runConfig: PlatformRunConfig;
  if (distinct.size > 1) {
    await services.revisions.updateStatus(revisionId, {
      status: 'rejected', verdictReason: 'eval_window_inconsistent', updatedAt: now(),
    });
    await services.events.append(event(task.id, 'eval_window.inconsistent', {
      revisionId, version, windows: [...distinct.values()],
    }));
    await services.events.append(event(task.id, 'revision.rejected', {
      revisionId, version, reasons: ['eval_window_inconsistent'],
    }));
    return;
  }
  if (distinct.size === 1) {
    runConfig = [...distinct.values()][0]!;
  } else {
    runConfig = services.defaultPlatformRun;
    await services.events.append(event(task.id, 'eval_window.fallback', { reason: 'no_cycle_window' }));
  }
  const acceptedParamsHash = computeStrategyParamsHash({ bundleHash: baseBundle.bundleHash, platformRun: runConfig, params: {} });
  const existingBaselineRun = await services.strategyBacktests.findByBundleAndParams(
    baseBundle.manifest.id, acceptedParamsHash, baseBundle.bundleHash,
  );
  let baselinePlatformRunId: string | null = null;
  let baselineMetrics: BacktestMetricBlock | null =
    existingBaselineRun && existingBaselineRun.status === 'completed' && existingBaselineRun.metrics
      ? existingBaselineRun.metrics
      : null;
  if (baselineMetrics && existingBaselineRun) baselinePlatformRunId = existingBaselineRun.platformRunId;
  if (!baselineMetrics) {
    const cmp = await services.revisionRunExecutor.execute({
      revisionId, label: 'comparison_baseline', strategyBundle: baseBundle,
      strategyProfileId, run: runConfig, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
    });
    baselineMetrics = cmp.status === 'completed' && cmp.metrics ? cmp.metrics : null;
    if (baselineMetrics) baselinePlatformRunId = cmp.platformRunId;
  }
  if (!baselineMetrics) {
    await services.revisions.updateStatus(revisionId, {
      status: 'rejected', verdictReason: 'comparison_baseline_unavailable', updatedAt: now(),
    });
    await services.events.append(event(task.id, 'revision.rejected', {
      revisionId, version, reasons: ['comparison_baseline_unavailable'],
    }));
    return;
  }

  // --- R3a Task 2: OOS holdout boundary (fixed once from the full-window baseline trades) ---
  // Computed here so it is available to Task 3's activation, but this slice only records an
  // observable skip (fail-soft, never a silent drop) on any non-trade_based outcome — the greedy
  // loop and ACCEPT below still run on the full window unchanged.
  let boundary: HoldoutBoundary = { mode: 'none', lowConfidence: false, reason: 'insufficient_history' };
  let holdoutValidation: HoldoutValidation | undefined;
  try {
    const fullBaselineTrades = await services.runTrades.getRunTrades(baselinePlatformRunId!);
    boundary = resolveHoldoutBoundary(fullBaselineTrades, runConfig.period, DEFAULT_HOLDOUT_POLICY);
  } catch (err) {
    holdoutValidation = { mode: 'none', reason: 'boundary_unavailable' };
    await services.events.append(event(task.id, 'revision.holdout_skipped', {
      revisionId, reason: 'boundary_unavailable', detail: errMsg(err),
    }));
  }
  if (!holdoutValidation && boundary.mode === 'none') {
    const reason = boundary.reason === 'insufficient_trades' ? 'skipped_insufficient_trades' : 'skipped_insufficient_history';
    holdoutValidation = { mode: 'none', reason };
    await services.events.append(event(task.id, 'revision.holdout_skipped', { revisionId, reason }));
  }

  // --- R3a Task 3: selection window/baseline swap ---
  // Selection (the greedy loop below) runs on the TRAIN window against a TRAIN baseline when a
  // trade_based boundary exists; otherwise it runs on the full window against the full-window
  // baseline (unchanged behavior for mode:'none'/unavailable). The train baseline is a SEPARATE
  // executor call, not a reuse of the full-window baselineMetrics/baselinePlatformRunId — those
  // only derived T (the boundary), and comparing a train-window candidate against a full-window
  // baseline would be an apples-to-oranges evaluateRevision/R2-veto comparison.
  let selectionConfig = runConfig;
  let selectionBaselineMetrics = baselineMetrics;
  let selectionBaselinePlatformRunId = baselinePlatformRunId;
  if (boundary.mode === 'trade_based' && boundary.t) {
    selectionConfig = { ...runConfig, period: encodeTrainPeriod(runConfig.period.from, boundary.t, runConfig.timeframe) };
    const tb = await services.revisionRunExecutor.execute({
      revisionId, label: 'train_baseline', strategyBundle: baseBundle,
      strategyProfileId, run: selectionConfig, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
    });
    if (tb.status !== 'completed' || !tb.metrics) {
      // train baseline unavailable: fall back to the full-window gate-skipped path — selection
      // (and the ACCEPT path) proceeds on the full window exactly as mode:'none' would.
      holdoutValidation = { mode: 'none', reason: 'boundary_unavailable' };
      await services.events.append(event(task.id, 'revision.holdout_skipped', {
        revisionId, reason: 'boundary_unavailable', detail: 'train_baseline_unavailable',
      }));
      boundary = { mode: 'none', lowConfidence: false, reason: 'insufficient_history' };
      selectionConfig = runConfig;
      selectionBaselineMetrics = baselineMetrics;
      selectionBaselinePlatformRunId = baselinePlatformRunId;
    } else {
      selectionBaselineMetrics = tb.metrics;
      selectionBaselinePlatformRunId = tb.platformRunId;
    }
  }

  // --- Steps 9-10: candidate run + evaluate, greedy degradation (<= 3 candidate runs total) ---
  let currentIds = [...compose.included];
  let verdict: RevisionVerdict = { decision: 'REJECT', reasons: ['not_attempted'] };
  let acceptedRun: RevisionRunResult | null = null;
  let acceptedMetrics: BacktestMetricBlock | undefined;
  const allRejectReasons: string[] = [];

  const gateOn = services.preservationGateEnabled && selectionBaselinePlatformRunId !== null;
  // Baseline trades are fetched lazily on the first would-accept verdict and cached across greedy
  // retries. A candidate that never reaches ACCEPT (aggregate-reject) triggers no trade fetch at
  // all, so a trades-read failure can't turn into a spurious revision.build abort for a build the
  // gate would never have judged.
  let baselineTrades: TradeRecord[] | null = null;
  let firedPreservation: PreservationMetadata | null = null;

  for (let attempt = 0; ; attempt++) {
    const result = await services.revisionRunExecutor.execute({
      revisionId, label: 'candidate', strategyBundle: assembled,
      strategyProfileId, run: selectionConfig, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
    });

    if (result.status === 'completed' && result.metrics) {
      verdict = evaluateRevision({ accepted: selectionBaselineMetrics, candidate: result.metrics }, DEFAULT_REVISION_EVALUATOR_POLICY);
      if (gateOn && verdict.decision === 'ACCEPT') {
        try {
          if (baselineTrades === null) baselineTrades = await services.runTrades.getRunTrades(selectionBaselinePlatformRunId!);
          const variantTrades = await services.runTrades.getRunTrades(result.platformRunId);
          const gated = applyRevisionPreservationGate(
            verdict, baselineTrades, variantTrades,
            { baseline: { netPnlUsd: selectionBaselineMetrics.netPnlUsd, totalTrades: selectionBaselineMetrics.totalTrades },
              variant: { netPnlUsd: result.metrics.netPnlUsd, totalTrades: result.metrics.totalTrades } },
            services.preservationThresholds,
          );
          verdict = gated.verdict;
          if (gated.preservation) firedPreservation = gated.preservation;
        } catch (err) {
          await services.events.append(event(task.id, 'revision.preservation_skipped', { revisionId, reason: 'fetch_failed', detail: errMsg(err) }));
        }
      }
    } else {
      verdict = { decision: 'REJECT', reasons: ['candidate_run_unavailable'] };
    }

    if (verdict.decision === 'ACCEPT') {
      acceptedRun = result;
      acceptedMetrics = result.metrics;
      break;
    }
    allRejectReasons.push(...verdict.reasons);

    if (attempt >= MAX_RETRIES || currentIds.length === 0) break;

    const worstId = currentIds[currentIds.length - 1]!;
    currentIds = currentIds.slice(0, -1);
    await services.hypotheses.updateStatus(worstId, 'dropped_combo_fail');
    const detail = `combo evaluation rejected: ${verdict.reasons.join(', ')}`;
    dropped.push({ hypothesisId: worstId, reason: 'combo_fail_dropped', detail });
    await services.events.append(event(task.id, 'revision.hypothesis_dropped', {
      hypothesisId: worstId, reason: 'combo_fail_dropped', detail,
    }));

    if (currentIds.length === 0) break;

    const reducedOverlays = overlays.filter((o) => currentIds.includes(o.hypothesisId));
    const reducedRuleActions: Record<string, RuleAction> = {};
    for (const id of currentIds) reducedRuleActions[id] = ruleActions[id]!;
    compose = composeRevisionBundle({
      baseSource: baseBundle.source, baseManifestMeta: baseBundle.manifest as StrategyManifestMeta,
      overlays: reducedOverlays, ruleActions: reducedRuleActions, revisionVersion: version, theses,
    });
    assembled = await assembleStrategyBundle(compose.output);
    const val = validateStrategyBundle(assembled);
    if (val.status === 'rejected') {
      allRejectReasons.push('bundle_invalid');
      break;
    }
    bundleArtifactRef = await putBundleWrapper(services, assembled);
    await services.revisions.updateStatus(revisionId, {
      bundleArtifactRef, bundleHash: assembled.bundleHash,
      hypothesisIds: [...compose.included], mergedRuleSet: compose.mergedRuleSet, dropped: [...dropped], updatedAt: now(),
    });
  }

  // --- R3a Task 3: holdout confirmation ---
  // A train-accepted candidate must not degrade on the held-out [T..to) window. Downgrade-only:
  // this stage runs ONLY when the greedy loop already reached ACCEPT on the train window, and it
  // can only turn that ACCEPT into a reject — it never manufactures an accept from a reject.
  if (boundary.mode === 'trade_based' && boundary.t && verdict.decision === 'ACCEPT' && acceptedRun && acceptedMetrics) {
    const holdoutConfig = { ...runConfig, period: encodeHoldoutPeriod(boundary.t, runConfig.period.to) };
    const hBase = await services.revisionRunExecutor.execute({
      revisionId, label: 'holdout_baseline', strategyBundle: baseBundle,
      strategyProfileId, run: holdoutConfig, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
    });
    const hCand = await services.revisionRunExecutor.execute({
      revisionId, label: 'holdout_candidate', strategyBundle: assembled,
      strategyProfileId, run: holdoutConfig, metrics: [...RESEARCH_RUN_METRICS], correlationId: task.correlationId,
    });
    const hBaseM = hBase.status === 'completed' ? hBase.metrics : undefined;
    const hCandM = hCand.status === 'completed' ? hCand.metrics : undefined;
    const holdoutVerdict: RevisionVerdict = hBaseM && hCandM
      ? evaluateRevision({ accepted: hBaseM, candidate: hCandM }, DEFAULT_REVISION_EVALUATOR_POLICY)
      : { decision: 'REJECT', reasons: ['holdout_run_unavailable'] };
    const trainMetrics = acceptedMetrics as unknown as Record<string, unknown>;
    if (holdoutVerdict.decision !== 'ACCEPT') {
      holdoutValidation = {
        mode: 'trade_based', t: boundary.t, reason: 'holdout_failed', lowConfidence: boundary.lowConfidence,
        trainMetrics, holdoutMetrics: (hCandM as unknown as Record<string, unknown>) ?? undefined,
      };
      await services.revisions.updateStatus(revisionId, {
        status: 'rejected', verdictReason: 'holdout_failed', preservationGate: firedPreservation ?? undefined,
        holdoutValidation, updatedAt: now(),
      });
      await services.events.append(event(task.id, 'revision.holdout_validated', {
        revisionId, version, mode: 'trade_based', t: boundary.t, decision: holdoutVerdict.decision, reasons: holdoutVerdict.reasons,
        lowConfidence: boundary.lowConfidence, trainMetrics, holdoutMetrics: (hCandM as unknown as Record<string, unknown>) ?? undefined,
      }));
      await services.events.append(event(task.id, 'revision.rejected', { revisionId, version, reasons: ['holdout_failed'] }));
      return;
    }
    // holdout passed: the holdout run becomes the accepted run-context (primary comboBacktestRunId/metrics).
    holdoutValidation = {
      mode: 'trade_based', t: boundary.t, reason: 'holdout_passed', lowConfidence: boundary.lowConfidence,
      trainMetrics, holdoutMetrics: hCandM as unknown as Record<string, unknown>,
    };
    acceptedRun = hCand;
    acceptedMetrics = hCandM;
    await services.events.append(event(task.id, 'revision.holdout_validated', {
      revisionId, version, mode: 'trade_based', t: boundary.t, decision: 'ACCEPT', lowConfidence: boundary.lowConfidence, trainMetrics, holdoutMetrics: hCandM,
    }));
  }

  if (verdict.decision === 'ACCEPT' && acceptedRun && acceptedMetrics) {
    await services.revisions.updateStatus(revisionId, {
      status: 'accepted', metrics: acceptedMetrics as unknown as Record<string, unknown>,
      comboBacktestRunId: acceptedRun.runId, verdictReason: verdict.reasons.join(', '),
      preservationGate: firedPreservation ?? undefined, holdoutValidation: holdoutValidation ?? undefined,
      updatedAt: now(),
    });
    for (const id of currentIds) {
      await services.hypotheses.updateStatus(id, 'merged');
    }
    await services.events.append(event(task.id, 'revision.accepted', {
      revisionId, version, included: currentIds, metrics: acceptedMetrics,
    }));

    // G3b consolidation trigger: fire revision.consolidate once the accepted revision's
    // composition depth crosses the configured threshold. `services.consolidator !== null`
    // and `consolidationDepthThreshold > 0` gate this off by default (null consolidator / 0
    // threshold both keep every existing revision.build test inert).
    const newDepth = (accepted.compositionDepth ?? 1) + 1;
    if (services.consolidator !== null && services.consolidationDepthThreshold > 0 && newDepth >= services.consolidationDepthThreshold) {
      await createAndEnqueueTask(
        {
          taskType: 'revision.consolidate', source: task.source,
          payload: { revisionId, strategyProfileId }, correlationId: task.correlationId,
          dedupeKey: `revision.consolidate:${revisionId}`,
        },
        { repo: services.researchTasks, queue: services.taskQueue },
      );
    } else {
      // R1 (W1 fix): no consolidation -> re-baseline the accepted composed revision directly so it
      // returns to paper via the same strategy.baseline -> wfo -> paper.start chain. Mutually
      // exclusive with the consolidation branch above (which re-baselines the consolidated
      // revision instead), so an accepted revision is never re-baselined twice / double-submitted
      // to paper.
      await services.revisions.updateStatus(revisionId, { baselineValidationStatus: 'pending', updatedAt: now() });
      await createAndEnqueueTask(
        {
          taskType: 'strategy.baseline', source: task.source,
          payload: { strategyProfileId, bundleArtifactRef, revisionId },
          correlationId: task.correlationId,
          dedupeKey: `strategy.baseline:accepted:${revisionId}`,
        },
        { repo: services.researchTasks, queue: services.taskQueue },
      );
    }
  } else {
    await services.revisions.updateStatus(revisionId, {
      status: 'rejected', verdictReason: allRejectReasons.join(', '),
      preservationGate: firedPreservation ?? undefined, holdoutValidation: holdoutValidation ?? undefined,
      updatedAt: now(),
    });
    await services.events.append(event(task.id, 'revision.rejected', {
      revisionId, version, reasons: allRejectReasons,
    }));
  }
};
