import type { Agent } from '@mastra/core/agent';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import { ResearcherOutputSchema, type ResearcherOutput } from '../../domain/hypothesis.ts';

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

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async propose(input: ResearcherInput): Promise<ResearcherOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: ResearcherOutputSchema },
    });
    // Re-parse to guarantee the typed shape regardless of the SDK's inferred return type.
    return ResearcherOutputSchema.parse(result.object);
  }
}
