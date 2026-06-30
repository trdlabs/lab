// src/orchestrator/handlers/research-run-cycle.handler.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import type { BotRunResultDetail, CloseReason } from '../../ports/bot-results-read.port.ts';
import type { ClosedTrade } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';
import type { CanonicalRowV2 } from '../../ports/market-history-read.port.ts';
import { validateHypothesis } from '../../validation/hypothesis-validator.ts';
import { LAB_FEATURE_CATALOG, normalizeFeature } from '../../domain/hypothesis-rules.ts';
import {
  ResearcherOutputSchema, hypothesisFingerprint,
  HYPOTHESIS_PROPOSAL_CONTRACT_VERSION, type HypothesisProposal, type HypothesisProposalDraft,
} from '../../domain/hypothesis.ts';
import type { ResearcherFocus, ActiveOverlayRuleSummary, ResearcherInput } from '../../ports/researcher.port.ts';
import { makeOnUsage } from '../make-on-usage.ts';
import { buildMarketContextMath } from '../../research-math/market-context-math.ts';
import { formatMarketContextMath } from '../../research-math/format-market-context-math.ts';
import { buildTradeContextMath, type TradeContextMath } from '../../research-math/trade-context-math.ts';

export const RESEARCH_DEFAULT_SYMBOL = 'BTCUSDT';
export const BOT_RESULTS_MAX = 10;
export const TRADE_EVIDENCE_MAX = 5;

const RESEARCHER_MAX_PER_PASS_DEFAULT = 5;
const TRADE_CONTEXT_WINNERS_MAX_DEFAULT = 5;

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

function selectSuspiciousTrades(botResults: readonly BotRunResultDetail[], limit = TRADE_EVIDENCE_MAX): ClosedTrade[] {
  return botResults
    .flatMap((detail) => detail.trades)
    .filter((trade) => Number(trade.realizedPnl) < 0)
    .slice()
    .sort((a: ClosedTrade, b: ClosedTrade) =>
      Number(a.realizedPnl) - Number(b.realizedPnl)
      || ((b.closedAtMs ?? 0) - b.openedAtMs) - ((a.closedAtMs ?? 0) - a.openedAtMs)
      || a.tradeId.localeCompare(b.tradeId))
    .slice(0, limit);
}

/** Canonical close-reason vocabulary lab recognizes once the platform ships the typed CloseReason enum. */
export const CANONICAL_CLOSE_REASONS = [
  'take_profit_final', 'take_profit_partial', 'stop_loss', 'breakeven',
  'trailing_stop', 'signal_exit', 'time_exit', 'liquidation', 'manual', 'other',
] as const;

// Compile-time drift guard: CANONICAL_CLOSE_REASONS must equal the SDK CloseReason union exactly.
type _CanonReason = (typeof CANONICAL_CLOSE_REASONS)[number];
const _closeReasonConformance: ([_CanonReason] extends [CloseReason] ? true : never)
  & ([CloseReason] extends [_CanonReason] ? true : never) = true;
void _closeReasonConformance;

/** True once closeReason carries a recognized canonical member (i.e. the SDK enum has shipped). */
export function isTypedCloseReason(reason: string | null): boolean {
  return reason != null && (CANONICAL_CLOSE_REASONS as readonly string[]).includes(reason);
}

/** "Exited early / left headroom" close reasons — prime profit-improvement candidates. */
const HEADROOM_CLOSE_REASONS = new Set(['take_profit_partial', 'breakeven', 'signal_exit', 'time_exit']);

/** Winners = isWin===true, or (isWin==null && realizedPnl>0) fallback. Recency order (closedAt DESC). Uncapped. */
export function selectWinningTrades(botResults: readonly BotRunResultDetail[]): ClosedTrade[] {
  return botResults
    .flatMap((detail) => detail.trades)
    .filter((t) => t.isWin === true || (t.isWin == null && Number(t.realizedPnl) > 0))
    .slice()
    .sort((a, b) =>
      ((b.closedAtMs ?? 0) - (a.closedAtMs ?? 0)) || a.tradeId.localeCompare(b.tradeId));
}

/** Typed path: headroom-class reasons first, then by recency; tiebreak tradeId. */
export function rankWinnersTyped(winners: readonly ClosedTrade[], cap: number): ClosedTrade[] {
  return winners.slice().sort((a, b) => {
    const ah = HEADROOM_CLOSE_REASONS.has(a.closeReason ?? '') ? 0 : 1;
    const bh = HEADROOM_CLOSE_REASONS.has(b.closeReason ?? '') ? 0 : 1;
    return (ah - bh)
      || ((b.closedAtMs ?? 0) - (a.closedAtMs ?? 0))
      || a.tradeId.localeCompare(b.tradeId);
  }).slice(0, cap);
}

/** Favourable continuation after exit, as a fraction of the exit-bar close. Vocabulary-free.
 *  Long: (max high after exit − exitClose)/exitClose. Short: (exitClose − min low after exit)/exitClose.
 *  0 when no post-exit bars or no usable exit bar. Never NaN. */
export function postExitHeadroomPct(trade: ClosedTrade, rows: readonly CanonicalRowV2[]): number {
  const exitMs = trade.closedAtMs;
  if (exitMs == null || rows.length === 0) return 0;
  let exitIdx = -1;
  for (let i = 0; i < rows.length; i += 1) { if (rows[i]!.minute_ts <= exitMs) exitIdx = i; else break; }
  if (exitIdx < 0) return 0;
  const exitClose = rows[exitIdx]!.close;
  if (!(exitClose > 0)) return 0;
  const tail = rows.slice(exitIdx + 1);
  if (tail.length === 0) return 0;
  if (trade.side === 'long') {
    const hi = Math.max(...tail.map((r) => r.high));
    return Math.max(0, (hi - exitClose) / exitClose);
  }
  const lo = Math.min(...tail.map((r) => r.low));
  return Math.max(0, (exitClose - lo) / exitClose);
}

/** Fallback path: rank by post-exit headroom DESC; tiebreak recency then tradeId. */
export function rankWinnersByHeadroom(
  winners: readonly ClosedTrade[],
  rowsByTradeId: ReadonlyMap<string, readonly CanonicalRowV2[]>,
  cap: number,
): ClosedTrade[] {
  return winners.slice().sort((a, b) => {
    const ha = postExitHeadroomPct(a, rowsByTradeId.get(a.tradeId) ?? []);
    const hb = postExitHeadroomPct(b, rowsByTradeId.get(b.tradeId) ?? []);
    return (hb - ha)
      || ((b.closedAtMs ?? 0) - (a.closedAtMs ?? 0))
      || a.tradeId.localeCompare(b.tradeId);
  }).slice(0, cap);
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

  const suspicious = selectSuspiciousTrades(botResults);

  let tradeEvidence: readonly TradeEvidenceBundle[] = [];
  try {
    if (suspicious.length > 0) {
      tradeEvidence = await services.tradeEvidence.getTradeEvidence({
        tradeIds: suspicious.map((t) => t.tradeId),
        minuteWindowBefore: 20,
        minuteWindowAfter: 180,
      });
    }
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.trade_evidence_unavailable', { error: errMsg(err) }));
    tradeEvidence = [];
  }

  const parsedWarmup = Number(process.env.TRADE_CONTEXT_WARMUP_MIN ?? '150');
  const warmupMin = Number.isFinite(parsedWarmup) && parsedWarmup > 0 ? parsedWarmup : 150;
  const parsedTail = Number(process.env.TRADE_CONTEXT_TAIL_MIN ?? '60');
  const tailMin = Number.isFinite(parsedTail) && parsedTail > 0 ? parsedTail : 60;

  const tradeContexts: TradeContextMath[] = [];
  {
    for (const t of suspicious) {
      if (t.closedAtMs == null) continue;
      try {
        const fromMs = t.openedAtMs - warmupMin * 60_000;
        const rows = await services.marketHistory.getRows({ symbol: t.symbol, fromMs, toMs: t.closedAtMs + tailMin * 60_000 });
        const pnlPctNum = Number(t.pnlPct);
        const realizedPnlNum = Number(t.realizedPnl);
        tradeContexts.push(buildTradeContextMath({
          tradeId: t.tradeId, symbol: t.symbol, rows,
          entryMs: t.openedAtMs, exitMs: t.closedAtMs,
          realizedPnl: Number.isFinite(realizedPnlNum) ? realizedPnlNum : 0, pnlPct: Number.isFinite(pnlPctNum) ? pnlPctNum : null,
          closeReason: t.closeReason ?? null,
          direction: profile.direction, regime: marketRegime, requiredFeatures: profile.requiredMarketFeatures,
        }, Date.now()));
      } catch (err) {
        await services.events.append(event(task.id, 'researcher.trade_context_unavailable', { tradeId: t.tradeId, error: errMsg(err) }));
      }
    }
  }

  // --- Winning-trade context (profit-improvement pass) ---
  const parsedWinnersMax = Number(process.env.TRADE_CONTEXT_WINNERS_MAX ?? String(TRADE_CONTEXT_WINNERS_MAX_DEFAULT));
  const winnersMax = Number.isFinite(parsedWinnersMax) && parsedWinnersMax > 0 ? Math.floor(parsedWinnersMax) : TRADE_CONTEXT_WINNERS_MAX_DEFAULT;
  const winnerContexts: TradeContextMath[] = [];
  {
    const allWinners = selectWinningTrades(botResults).filter((t) => t.closedAtMs != null);
    const typed = allWinners.length > 0 && allWinners.every((t) => isTypedCloseReason(t.closeReason));
    // Fetch rows once per candidate (bounded pool), reused for both ranking and context.
    const pool = typed ? rankWinnersTyped(allWinners, winnersMax) : allWinners.slice(0, winnersMax * 2);
    const rowsByTradeId = new Map<string, readonly CanonicalRowV2[]>();
    for (const t of pool) {
      if (t.closedAtMs == null) continue;
      try {
        const fromMs = t.openedAtMs - warmupMin * 60_000;
        const rows = await services.marketHistory.getRows({ symbol: t.symbol, fromMs, toMs: t.closedAtMs + tailMin * 60_000 });
        rowsByTradeId.set(t.tradeId, rows);
      } catch (err) {
        await services.events.append(event(task.id, 'researcher.trade_context_unavailable', { tradeId: t.tradeId, error: errMsg(err) }));
      }
    }
    const selectedWinners = typed ? pool : rankWinnersByHeadroom(pool, rowsByTradeId, winnersMax);
    for (const t of selectedWinners) {
      const rows = rowsByTradeId.get(t.tradeId);
      if (t.closedAtMs == null || !rows || rows.length === 0) continue;
      const pnlPctNum = Number(t.pnlPct);
      const realizedPnlNum = Number(t.realizedPnl);
      winnerContexts.push(buildTradeContextMath({
        tradeId: t.tradeId, symbol: t.symbol, rows,
        entryMs: t.openedAtMs, exitMs: t.closedAtMs,
        realizedPnl: Number.isFinite(realizedPnlNum) ? realizedPnlNum : 0, pnlPct: Number.isFinite(pnlPctNum) ? pnlPctNum : null,
        closeReason: t.closeReason ?? null,
        direction: profile.direction, regime: marketRegime, requiredFeatures: profile.requiredMarketFeatures,
      }, Date.now()));
    }
  }

  // Active overlay rules for both passes' critical framing.
  let activeOverlayRules: ActiveOverlayRuleSummary[] = [];
  try {
    const validatedProposals = (await services.hypotheses.listByStrategyProfile(profile.id))
      .filter((p) => p.status === 'validated');
    activeOverlayRules = validatedProposals.map((p) => ({ thesis: p.thesis, ruleAction: p.ruleAction, status: p.status }));
  } catch { activeOverlayRules = []; }

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

  const parsedPerPass = Number(process.env.RESEARCHER_MAX_PER_PASS ?? String(RESEARCHER_MAX_PER_PASS_DEFAULT));
  const rawPerPass = Number.isFinite(parsedPerPass) && parsedPerPass > 0 ? Math.floor(parsedPerPass) : RESEARCHER_MAX_PER_PASS_DEFAULT;
  const maxPerPass = Math.min(rawPerPass, effectiveMax);

  await services.events.append(event(task.id, 'researcher.started', { strategyProfileId: profile.id }));

  const runPass = async (
    focus: ResearcherFocus,
    extra: Partial<ResearcherInput>,
  ): Promise<{ draft: HypothesisProposalDraft; origin: ResearcherFocus }[]> => {
    const input: ResearcherInput = {
      profile, marketContext, marketRegime, similarHypotheses: focus === 'loss_reduction' ? similarHypotheses : [],
      botResults, maxHypotheses: maxPerPass, focus, activeOverlayRules,
      ...(marketContextMath && marketContextMath.terms.length > 0 ? { marketContextMath } : {}),
      ...extra,
    };
    const out = await services.researcher.propose(input, {
      ...makeOnUsage(task, services),
      ...(marketContextArtifactId ? { tracingMetadata: { research_market_context_artifact_id: marketContextArtifactId } } : {}),
    });
    const parsedPass = validateWithSchema(ResearcherOutputSchema, out);
    if (parsedPass.status === 'invalid') {
      throw new Error(`researcher returned invalid output (${focus}): ${JSON.stringify(parsedPass.issues)}`);
    }
    const passDrafts = parsedPass.data.hypotheses.slice(0, maxPerPass);
    await services.events.append(event(task.id, 'researcher.pass_completed', { focus, count: passDrafts.length }));
    return passDrafts.map((draft) => ({ draft, origin: focus }));
  };

  let taggedDrafts: { draft: HypothesisProposalDraft; origin: ResearcherFocus }[] = [];
  try {
    taggedDrafts = await runPass('loss_reduction', {
      tradeEvidence,
      ...(tradeContexts.length > 0 ? { tradeContexts } : {}),
    });
    if (winnerContexts.length > 0) {
      const profitDrafts = await runPass('profit_improvement', { tradeContexts: winnerContexts });
      taggedDrafts = [...taggedDrafts, ...profitDrafts];
    }
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.failed', { error: errMsg(err) }));
    throw err;
  }
  await services.events.append(event(task.id, 'researcher.completed', { count: taggedDrafts.length }));

  const allowedFeatures = new Set<string>([
    ...profile.requiredMarketFeatures.map(normalizeFeature),
    ...LAB_FEATURE_CATALOG,
  ]);

  const seen = new Set<string>(await services.hypotheses.listFingerprints(profile.id));
  let validated = 0;
  let rejected = 0;
  let deduped = 0;
  let criticReviews = 0;

  for (const { draft, origin } of taggedDrafts) {
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
      origin,
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
    proposed: taggedDrafts.length, validated, rejected, deduped, criticReviews,
  }));
};
