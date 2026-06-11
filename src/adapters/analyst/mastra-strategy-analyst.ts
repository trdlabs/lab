import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../llm/model-provider.ts';
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import { AnalystProfileOutputSchema, type AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';

const INSTRUCTIONS = [
  'You are a trading-strategy analyst.',
  'Given a strategy source (code, README, article, summary, or description), extract a structured profile.',
  'Do not invent details; put anything you are unsure about in `unknowns`.',
  'Anything that belongs to risk sizing, order execution, or fills is owned by the runner/platform —',
  'list those concerns in `runnerOwnedAuthorities`, do not propose live execution.',
  'Mark tunable parameters with tunable: true.',
].join(' ');

function buildPrompt(input: StrategyAnalystInput): string {
  const header =
    `Source kind: ${input.kind}` +
    (input.title ? `\nTitle: ${input.title}` : '') +
    (input.uri ? `\nURI: ${input.uri}` : '');
  return `${header}\n\n--- SOURCE START ---\n${input.content}\n--- SOURCE END ---\n\nReturn the structured strategy profile.`;
}

export class MastraStrategyAnalyst implements StrategyAnalystPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: ProviderModel, label: string) {
    this.model = label;
    this.agent = new Agent({
      id: 'strategy-analyst',
      name: 'Strategy Analyst',
      instructions: INSTRUCTIONS,
      model,
    });
  }

  async analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: AnalystProfileOutputSchema },
    });
    // Re-parse to guarantee the typed shape regardless of the SDK's inferred return type.
    return AnalystProfileOutputSchema.parse(result.object);
  }
}
