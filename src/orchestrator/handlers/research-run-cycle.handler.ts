// src/orchestrator/handlers/research-run-cycle.handler.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { ClosedTrade } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';
import { validateHypothesis } from '../../validation/hypothesis-validator.ts';
import { LAB_FEATURE_CATALOG, normalizeFeature } from '../../domain/hypothesis-rules.ts';
import {
  ResearcherOutputSchema, hypothesisFingerprint,
  HYPOTHESIS_PROPOSAL_CONTRACT_VERSION, type HypothesisProposal, type ResearcherOutput,
} from '../../domain/hypothesis.ts';
import { makeOnUsage } from '../make-on-usage.ts';
import { buildMarketContextMath } from '../../research-math/market-context-math.ts';
import { formatMarketContextMath } from '../../research-math/format-market-context-math.ts';
import { buildTradeContextMath, type TradeContextMath } from '../../research-math/trade-context-math.ts';

export const RESEARCH_DEFAULT_SYMBOL = 'BTCUSDT';
export const BOT_RESULTS_MAX = 10;
export const TRADE_EVIDENCE_MAX = 5;

export const ResearchRunCyclePayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  symbol: z.string().min(1).optional(),
  ts: z.string().min(1).optional(),
  maxHypotheses: z.number().int().positive().optional(),
  /** Depth in the research→build→backtest cycle chain. 0 = initial run. */
  cycleDepth: z.number().int().min(0).default(0),
  /** Context from a previous FAIL / MODIFY evaluation to guide the new cycle. */
  feedback: z.object({
    hypothesisId: z.string(),
    decision: z.string(),
    reasons: z.array(z.string()),
  }).optional(),
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function event(taskId: string, type: string, payload: Record<string, unknown>) {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}

function selectSuspiciousTradeIds(botResults: readonly BotRunResultDetail[], limit = TRADE_EVIDENCE_MAX): string[] {
  return botResults
    .flatMap((detail) => detail.trades)
    .filter((trade) => Number(trade.realizedPnl) < 0)
    .slice()
    .sort((a: ClosedTrade, b: ClosedTrade) =>
      Number(a.realizedPnl) - Number(b.realizedPnl)
      || ((b.closedAtMs ?? 0) - b.openedAtMs) - ((a.closedAtMs ?? 0) - a.openedAtMs)
      || a.tradeId.localeCompare(b.tradeId))
    .slice(0, limit)
    .map((trade) => trade.tradeId);
}

export const researchRunCycleHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(ResearchRunCyclePayloadSchema, task.payload);
  if (parsed.status === 'invalid') {
    throw new Error(`invalid research.run_cycle payload: ${JSON.stringify(parsed.issues)}`);
  }
  const payload = parsed.data;

  const profile = await services.strategyProfiles.findById(payload.strategyProfileId);
  if (!profile) throw new Error(`strategy profile not found: ${payload.strategyProfileId}`);

  const effectiveMax = Math.min(
    payload.maxHypotheses ?? services.maxHypothesesPerCycle,
    services.maxHypothesesPerCycle,
  );

  await services.events.append(event(task.id, 'research.run_cycle.started', {
    strategyProfileId: profile.id,
    researcher: services.researcher.adapter,
    model: services.researcher.model,
    criticEnabled: services.critic !== null,
    effectiveMax,
  }));

  const symbol = payload.symbol ?? services.researchDefaultSymbol ?? RESEARCH_DEFAULT_SYMBOL;
  const ts = payload.ts ?? new Date().toISOString();
  const marketContext = await services.platform.getMarketContext(symbol, ts);
  const marketRegime = await services.platform.getMarketRegime(symbol, ts);

  const similarHypotheses = await services.similarHypotheses.search(profile.id, profile.coreIdea, 5);

  let botResults: readonly BotRunResultDetail[] = [];
  try {
    const runs = (await services.botResults.listBotRuns({ status: 'finished' }))
      .filter((r) => r.symbols.includes(symbol))
      .slice()
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
      .slice(0, BOT_RESULTS_MAX);
    botResults = await Promise.all(runs.map(async (run) => ({
      run,
      summary: await services.botResults.getRunSummary(run.runId),
      trades: await services.botResults.getClosedTrades(run.runId),
    })));
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.bot_results_unavailable', { error: errMsg(err) }));
  }

  let tradeEvidence: readonly TradeEvidenceBundle[] = [];
  try {
    const tradeIds = selectSuspiciousTradeIds(botResults);
    if (tradeIds.length > 0) {
      tradeEvidence = await services.tradeEvidence.getTradeEvidence({
        tradeIds,
        minuteWindowBefore: 20,
        minuteWindowAfter: 180,
      });
    }
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.trade_evidence_unavailable', { error: errMsg(err) }));
    tradeEvidence = [];
  }

  const tradeContexts: TradeContextMath[] = [];
  {
    const parsedWarmup = Number(process.env.TRADE_CONTEXT_WARMUP_MIN ?? '150');
    const warmupMin = Number.isFinite(parsedWarmup) && parsedWarmup > 0 ? parsedWarmup : 150;
    for (const b of tradeEvidence) {
      if (b.closedAtMs == null) continue;
      try {
        const fromMs = b.enteredAtMs - warmupMin * 60_000;
        const rows = await services.marketHistory.getRows({ symbol: b.symbol, fromMs, toMs: b.closedAtMs });
        const pnlPctNum = Number(b.pnlPct);
        tradeContexts.push(buildTradeContextMath({
          tradeId: b.tradeId, symbol: b.symbol, rows,
          entryMs: b.enteredAtMs, exitMs: b.closedAtMs,
          realizedPnl: Number(b.realizedPnl), pnlPct: Number.isFinite(pnlPctNum) ? pnlPctNum : null,
          closeReason: b.closeReason,
          direction: profile.direction, regime: marketRegime, requiredFeatures: profile.requiredMarketFeatures,
        }, Date.now()));
      } catch (err) {
        await services.events.append(event(task.id, 'researcher.trade_context_unavailable', { tradeId: b.tradeId, error: errMsg(err) }));
      }
    }
  }

  let marketContextMath;
  try {
    const parsedLookback = Number(process.env.MARKET_HISTORY_LOOKBACK_DAYS ?? '7');
    const lookbackDays = Number.isFinite(parsedLookback) && parsedLookback > 0 ? parsedLookback : 7;
    const toMs = Date.parse(ts);
    const fromMs = toMs - lookbackDays * 86_400_000;
    const rows = await services.marketHistory.getRows({ symbol, fromMs, toMs });
    marketContextMath = buildMarketContextMath({
      symbol, rows,
      direction: profile.direction,
      regime: marketRegime,
      requiredFeatures: profile.requiredMarketFeatures,
      window: { fromMs, toMs },
    }, Date.now());
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.market_history_unavailable', { error: errMsg(err) }));
    marketContextMath = undefined;
  }

  let marketContextArtifactId: string | undefined;
  if (marketContextMath && marketContextMath.terms.length > 0) {
    try {
      const markdown = formatMarketContextMath(marketContextMath);
      const ref = await services.artifacts.put(markdown, {
        kind: 'market-context-math',
        mime_type: 'text/markdown',
        producer: 'research-run-cycle',
        metadata: { correlationId: task.correlationId, symbol },
      });
      marketContextArtifactId = ref.artifact_id;
      await services.events.append(event(task.id, 'researcher.market_context_committed', {
        artifactId: ref.artifact_id, correlationId: task.correlationId, symbol,
      }));
    } catch { /* best-effort: never fail the cycle on artifact commit */ }
  }

  await services.events.append(event(task.id, 'researcher.started', { strategyProfileId: profile.id }));
  let output: ResearcherOutput;
  try {
    output = await services.researcher.propose({
      profile, marketContext, marketRegime, similarHypotheses, botResults, tradeEvidence, maxHypotheses: effectiveMax,
      ...(marketContextMath && marketContextMath.terms.length > 0 ? { marketContextMath } : {}),
      ...(tradeContexts.length > 0 ? { tradeContexts } : {}),
    }, {
      ...makeOnUsage(task, services),
      ...(marketContextArtifactId ? { tracingMetadata: { research_market_context_artifact_id: marketContextArtifactId } } : {}),
    });
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.failed', { error: errMsg(err) }));
    throw err;
  }
  await services.events.append(event(task.id, 'researcher.completed', { count: output.hypotheses.length }));

  const outParsed = validateWithSchema(ResearcherOutputSchema, output);
  if (outParsed.status === 'invalid') {
    throw new Error(`researcher returned invalid output: ${JSON.stringify(outParsed.issues)}`);
  }

  const drafts = outParsed.data.hypotheses.slice(0, effectiveMax);
  const allowedFeatures = new Set<string>([
    ...profile.requiredMarketFeatures.map(normalizeFeature),
    ...LAB_FEATURE_CATALOG,
  ]);

  const seen = new Set<string>(await services.hypotheses.listFingerprints(profile.id));
  let validated = 0;
  let rejected = 0;
  let deduped = 0;
  let criticReviews = 0;

  for (const draft of drafts) {
    const fingerprint = hypothesisFingerprint(draft.thesis, draft.ruleAction);
    if (seen.has(fingerprint)) {
      await services.events.append(event(task.id, 'hypothesis.deduped', { fingerprint }));
      deduped += 1;
      continue;
    }

    const result = validateHypothesis(draft, { allowedFeatures });
    seen.add(fingerprint); // add for BOTH validated and rejected, so identical later drafts dedupe

    const now = new Date().toISOString();
    const hypothesis: HypothesisProposal = {
      id: randomUUID(),
      strategyProfileId: profile.id,
      thesis: draft.thesis,
      targetBehavior: draft.targetBehavior,
      ruleAction: draft.ruleAction,
      requiredFeatures: result.normalizedFeatures,
      validationPlan: draft.validationPlan,
      expectedEffect: draft.expectedEffect,
      invalidationCriteria: draft.invalidationCriteria,
      confidence: draft.confidence,
      status: result.status,
      fingerprint,
      proposal: draft,
      issues: result.issues,
      contractVersion: HYPOTHESIS_PROPOSAL_CONTRACT_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    await services.hypotheses.create(hypothesis);

    if (result.status === 'validated') {
      validated += 1;
      await services.events.append(event(task.id, 'hypothesis.validated', { hypothesisId: hypothesis.id, fingerprint }));
      const buildTaskId = randomUUID();
      const buildTask: import('../../domain/types.ts').ResearchTask = {
        id: buildTaskId, taskType: 'hypothesis.build', source: task.source,
        correlationId: task.correlationId, status: 'queued',
        payload: { hypothesisId: hypothesis.id, platformRun: services.defaultPlatformRun, cycleDepth: payload.cycleDepth },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      await services.researchTasks.create(buildTask);
      await services.taskQueue.enqueue({
        taskId: buildTaskId, taskType: 'hypothesis.build',
        correlationId: task.correlationId, source: task.source, attempt: 1,
        dedupeKey: `hypothesis.build:${hypothesis.id}`,
      });
      if (services.critic) {
        try {
          const review = await services.critic.review(
            { proposal: draft, profile },
            makeOnUsage(task, services),
          );
          await services.hypothesisReviews.create({
            id: randomUUID(),
            hypothesisId: hypothesis.id,
            criticAdapter: services.critic.adapter,
            criticModel: services.critic.model,
            verdict: review.verdict,
            concerns: review.concerns,
            summary: review.summary,
            createdAt: new Date().toISOString(),
          });
          criticReviews += 1;
          await services.events.append(event(task.id, 'critic.reviewed', { hypothesisId: hypothesis.id, verdict: review.verdict }));
        } catch (err) {
          await services.events.append(event(task.id, 'critic.failed', { hypothesisId: hypothesis.id, error: errMsg(err) }));
        }
      }
    } else {
      rejected += 1;
      await services.events.append(event(task.id, 'hypothesis.rejected', {
        hypothesisId: hypothesis.id, fingerprint, codes: result.issues.map((i) => i.code),
      }));
    }
  }

  await services.events.append(event(task.id, 'research.run_cycle.completed', {
    proposed: drafts.length, validated, rejected, deduped, criticReviews,
  }));
};
