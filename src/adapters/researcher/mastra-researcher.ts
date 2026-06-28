import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import type { ResearcherInput, ResearcherPort, AgentCallOpts } from '../../ports/researcher.port.ts';
import { ResearcherOutputSchema, type ResearcherOutput } from '../../domain/hypothesis.ts';
import { OVERLAY_ACTIONS } from '../../domain/hypothesis-rules.ts';
import { DIRECTIONS } from '../../domain/strategy-profile.ts';
import { buildBotResultsDigestText } from './bot-results-digest.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';
import { formatMarketContextMath } from '../../research-math/format-market-context-math.ts';

/**
 * OpenAI/Azure strict mode requires all schema properties to be listed in `required`.
 * The domain schema uses `.optional()` (for DB back-compat) which removes fields from
 * `required`, causing a schema rejection before the request is even made.
 * This LLM-local schema uses `.nullable()` so optional fields stay in `required`
 * with `string | null` type — accepted by strict mode.
 */
const LlmHypothesisRuleSchema = z.object({
  when: z.string().min(1),
  action: z.enum(OVERLAY_ACTIONS),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  rationale: z.string().nullable(),
});

const LlmRuleActionSchema = z.object({
  appliesTo: z.enum(DIRECTIONS),
  rules: z.array(LlmHypothesisRuleSchema).min(1),
});

const LlmExpectedEffectSchema = z.object({
  metric: z.string().min(1),
  direction: z.enum(['increase', 'decrease']),
  magnitude: z.string().nullable(),
});

const LlmHypothesisProposalSchema = z.object({
  thesis: z.string().min(1),
  targetBehavior: z.string().min(1),
  ruleAction: LlmRuleActionSchema,
  requiredFeatures: z.array(z.string()),
  validationPlan: z.string().min(1),
  expectedEffect: LlmExpectedEffectSchema,
  invalidationCriteria: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});

const LlmResearcherOutputSchema = z.object({
  hypotheses: z.array(LlmHypothesisProposalSchema),
  researchSummary: z.string(),
});
type LlmResearcherOutput = z.infer<typeof LlmResearcherOutputSchema>;

/** Coerce LLM nullable fields back to domain optional (null → omit). */
function llmOutputToDomain(llm: LlmResearcherOutput): ResearcherOutput {
  return ResearcherOutputSchema.parse({
    researchSummary: llm.researchSummary,
    hypotheses: llm.hypotheses.map((h) => ({
      ...h,
      ruleAction: {
        ...h.ruleAction,
        rules: h.ruleAction.rules.map((r) => ({
          ...r,
          ...(r.rationale !== null ? { rationale: r.rationale } : {}),
        })),
      },
      expectedEffect: {
        metric: h.expectedEffect.metric,
        direction: h.expectedEffect.direction,
        ...(h.expectedEffect.magnitude !== null ? { magnitude: h.expectedEffect.magnitude } : {}),
      },
    })),
  });
}

function profileDetailsText(input: ResearcherInput): string[] {
  const profile = input.profile.profile;
  if (!profile) return [];
  return [
    `Strategy summary: ${profile.summary}`,
    `Entry conditions: ${profile.entryConditions.join(' | ') || '(none)'}`,
    `Exit conditions: ${profile.exitConditions.join(' | ') || '(none)'}`,
    `Parameters: ${(profile.parameters ?? []).map((p) => `${p.name}=${String(p.value)}`).join(' | ') || '(none)'}`,
    `Position management: ${profile.positionManagementSummary ?? '(none)'}`,
    `Risk management: ${profile.riskManagementSummary ?? '(none)'}`,
    `Unknowns: ${(profile.unknowns ?? []).join(' | ') || '(none)'}`,
    `Profile evidence: ${(profile.evidence ?? []).join(' | ') || '(none)'}`,
  ];
}

function forensicBundleText(bundles: readonly TradeEvidenceBundle[] | undefined): string[] {
  if (!bundles || bundles.length === 0) return [];
  return [
    'Forensic trade evidence:',
    ...bundles.flatMap((bundle) => [
      `- ${bundle.symbol} tradeId=${bundle.tradeId} entryPrice=${bundle.entryPrice ?? 'unknown'}`
      + ` exitPrice=${bundle.exitPrice ?? 'unknown'} pnlUsd=${bundle.realizedPnl}`
      + ` pnlPct=${bundle.pnlPct} holdingDurationMs=${bundle.holdingDurationMs ?? 'unknown'} closeReason=${bundle.closeReason ?? 'unknown'}`,
      ...bundle.lifecycleEvents.map((event) =>
        `  lifecycle tsMs=${event.tsMs} type=${event.type} price=${event.price ?? 'unknown'} qty=${event.qty ?? 'unknown'} note=${event.note ?? ''}`),
      ...bundle.minuteContext.map((point) =>
        `  minute tsMs=${point.tsMs} close=${point.close} volume=${point.volume ?? 'unknown'}`
        + ` oi=${point.oi ?? 'unknown'} liquidationsLong=${point.liquidationsLong ?? 'unknown'} liquidationsShort=${point.liquidationsShort ?? 'unknown'}`),
    ]),
  ];
}

export function buildPrompt(input: ResearcherInput): string {
  const similar = input.similarHypotheses.length > 0
    ? input.similarHypotheses.map((s) => `- [${s.status}] ${s.thesis}`).join('\n')
    : '(none)';
  const botPerf = buildBotResultsDigestText(input.botResults);
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Direction: ${input.profile.direction}`,
    `Profile required features: ${input.profile.requiredMarketFeatures.join(', ') || '(none)'}`,
    ...profileDetailsText(input),
    `Market regime: ${input.marketRegime}`,
    input.marketContextMath
      ? formatMarketContextMath(input.marketContextMath)
      : `Market context features: ${JSON.stringify(input.marketContext.features)}`,
    `Similar past hypotheses (advisory, avoid duplicating):\n${similar}`,
    ...(botPerf ? [botPerf] : []),
    ...forensicBundleText(input.tradeEvidence),
    `Produce at most ${input.maxHypotheses} hypotheses.`,
  ].join('\n');
}

export class MastraResearcher implements ResearcherPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async propose(input: ResearcherInput, opts?: AgentCallOpts): Promise<ResearcherOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: LlmResearcherOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      ...(opts?.tracingMetadata ? { tracingOptions: { metadata: opts.tracingMetadata } } : {}),
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    const llm = LlmResearcherOutputSchema.parse(result.object);
    return llmOutputToDomain(llm);
  }
}
