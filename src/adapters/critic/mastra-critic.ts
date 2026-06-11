import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../llm/model-provider.ts';
import type { CriticPort } from '../../ports/critic.port.ts';
import { CriticOutputSchema, type CriticInput, type CriticOutput } from '../../domain/critic.ts';

const INSTRUCTIONS = [
  'You are a skeptical research reviewer for trading hypotheses.',
  'Assess: is the hypothesis falsifiable? Is it likely overfit? Does it rely on lookahead or unavailable data?',
  'Is the sample size plausible? Does it overstep research-only boundaries (live execution, risk sizing)?',
  'Return concerns as advisory notes with severity info or warning. You do NOT approve or reject —',
  'a deterministic validator owns that decision. Set verdict to "concerns" if you raise any, else "ok".',
].join(' ');

function buildPrompt(input: CriticInput): string {
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Thesis: ${input.proposal.thesis}`,
    `Target behavior: ${input.proposal.targetBehavior}`,
    `Rule action: ${JSON.stringify(input.proposal.ruleAction)}`,
    `Validation plan: ${input.proposal.validationPlan}`,
    `Invalidation criteria: ${input.proposal.invalidationCriteria.join('; ')}`,
  ].join('\n');
}

export class MastraCritic implements CriticPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: ProviderModel, label: string) {
    this.model = label;
    this.agent = new Agent({
      id: 'critic',
      name: 'Critic',
      instructions: INSTRUCTIONS,
      model,
    });
  }

  async review(input: CriticInput): Promise<CriticOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: CriticOutputSchema },
    });
    return CriticOutputSchema.parse(result.object);
  }
}
