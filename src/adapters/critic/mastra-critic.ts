import type { Agent } from '@mastra/core/agent';
import type { CriticPort, AgentCallOpts } from '../../ports/critic.port.ts';
import { CriticOutputSchema, type CriticInput, type CriticOutput } from '../../domain/critic.ts';

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

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async review(input: CriticInput, opts?: AgentCallOpts): Promise<CriticOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: CriticOutputSchema },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    return CriticOutputSchema.parse(result.object);
  }
}
