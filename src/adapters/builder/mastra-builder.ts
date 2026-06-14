import type { Agent } from '@mastra/core/agent';
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import { BuilderOutputSchema } from '../../ports/builder.port.ts';

function buildPrompt(input: BuilderInput): string {
  return [
    `Hypothesis thesis: ${input.hypothesis.thesis}`,
    `Applies to: ${input.hypothesis.ruleAction.appliesTo}`,
    `Rules: ${JSON.stringify(input.hypothesis.ruleAction.rules)}`,
    `Required features (allowed capabilities): ${input.hypothesis.requiredFeatures.join(', ')}`,
    'Produce manifest.entry = "index.ts" and manifest.exports = ["overlay"].',
  ].join('\n');
}

export class MastraBuilder implements BuilderPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async build(input: BuilderInput): Promise<BuilderOutput> {
    const result = await this.agent.generate(buildPrompt(input), { structuredOutput: { schema: BuilderOutputSchema } });
    return BuilderOutputSchema.parse(result.object);
  }
}
