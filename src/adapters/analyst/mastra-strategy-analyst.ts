import { Agent } from '@mastra/core/agent';
import { anthropic } from '@ai-sdk/anthropic';
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

  constructor(model: string) {
    this.model = model;
    // Strip the provider prefix for @ai-sdk/anthropic, which accepts bare model IDs.
    // The full routing string (e.g. 'anthropic/claude-sonnet-4-6') is preserved in
    // this.model for audit purposes.
    const bareModelId = model.replace(/^anthropic\//, '');
    // This adapter is Anthropic-only. Reject any other provider prefix at construction
    // time with a clear error rather than passing a wrong id to anthropic() at call time.
    if (bareModelId.includes('/')) {
      throw new Error(`MastraStrategyAnalyst only supports Anthropic models; got '${model}'`);
    }
    this.agent = new Agent({
      id: 'strategy-analyst',
      name: 'Strategy Analyst',
      instructions: INSTRUCTIONS,
      model: anthropic(bareModelId),
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
