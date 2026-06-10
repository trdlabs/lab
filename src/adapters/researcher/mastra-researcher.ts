import { Agent } from '@mastra/core/agent';
import { anthropic } from '@ai-sdk/anthropic';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import { ResearcherOutputSchema, type ResearcherOutput } from '../../domain/hypothesis.ts';
import { OVERLAY_ACTIONS, LAB_FEATURE_CATALOG } from '../../domain/hypothesis-rules.ts';

const INSTRUCTIONS = [
  'You are a quantitative trading researcher.',
  'Given a strategy profile and market context, propose FALSIFIABLE hypotheses as overlay intents.',
  'Each hypothesis must change a specific behavior of the base strategy and be testable by backtest.',
  'This is research-only: never propose live order placement, execution, leverage, or risk sizing —',
  'those belong to the runner/platform. Use only overlay actions from the allowed set.',
  `Allowed overlay actions: ${OVERLAY_ACTIONS.join(', ')}.`,
  `Prefer market features from: ${LAB_FEATURE_CATALOG.join(', ')} (or features named in the profile).`,
  'Always provide invalidationCriteria (what observation would prove the hypothesis wrong).',
  'Respect the requested maximum number of hypotheses.',
].join(' ');

function buildPrompt(input: ResearcherInput): string {
  const similar = input.similarHypotheses.length > 0
    ? input.similarHypotheses.map((s) => `- [${s.status}] ${s.thesis}`).join('\n')
    : '(none)';
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Direction: ${input.profile.direction}`,
    `Profile required features: ${input.profile.requiredMarketFeatures.join(', ') || '(none)'}`,
    `Market regime: ${input.marketRegime}`,
    `Market context features: ${JSON.stringify(input.marketContext.features)}`,
    `Similar past hypotheses (advisory, avoid duplicating):\n${similar}`,
    `Produce at most ${input.maxHypotheses} hypotheses.`,
  ].join('\n');
}

export class MastraResearcher implements ResearcherPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: string) {
    this.model = model;
    // Strip the provider prefix for @ai-sdk/anthropic, which accepts bare model IDs.
    // The full routing string (e.g. 'anthropic/claude-sonnet-4-6') is preserved in
    // this.model for audit purposes.
    const bareModelId = model.replace(/^anthropic\//, '');
    // This adapter is Anthropic-only. Reject any other provider prefix at construction
    // time with a clear error rather than passing a wrong id to anthropic() at call time.
    if (bareModelId.includes('/')) {
      throw new Error(`MastraResearcher only supports Anthropic models; got '${model}'`);
    }
    this.agent = new Agent({
      id: 'researcher',
      name: 'Researcher',
      instructions: INSTRUCTIONS,
      model: anthropic(bareModelId),
    });
  }

  async propose(input: ResearcherInput): Promise<ResearcherOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: ResearcherOutputSchema },
    });
    // Re-parse to guarantee the typed shape regardless of the SDK's inferred return type.
    return ResearcherOutputSchema.parse(result.object);
  }
}
