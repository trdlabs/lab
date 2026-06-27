import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import type { StrategyCriticPort, AgentCallOpts } from '../../ports/strategy-critic.port.ts';
import {
  StrategyCritiqueSchema,
  StrategyRefinementSchema,
  type StrategyCriticInput,
  type StrategyCritique,
  type StrategyRefinement,
} from '../../domain/strategy-critic.ts';

const RefinementDeltaSchema = z.object({
  improvedStrategyText: z.string(),
  changeLog: z.array(z.string()),
});

function buildCritiquePrompt(input: StrategyCriticInput): string {
  const header =
    `Source kind: ${input.kind}` +
    (input.title ? `\nTitle: ${input.title}` : '') +
    (input.uri ? `\nURI: ${input.uri}` : '');
  return `${header}\n\n--- STRATEGY START ---\n${input.content}\n--- STRATEGY END ---\n\nCritique this strategy. Do not rewrite it.`;
}

function buildRefinePrompt(input: StrategyCriticInput, critique: StrategyCritique): string {
  return [
    '--- ORIGINAL STRATEGY START ---',
    input.content,
    '--- ORIGINAL STRATEGY END ---',
    '',
    '--- CRITIC FINDINGS (JSON) ---',
    JSON.stringify(critique),
    '--- END FINDINGS ---',
    '',
    'Rewrite the strategy description to address the findings and return improvedStrategyText + changeLog.',
  ].join('\n');
}

export class TwoStageStrategyCritic implements StrategyCriticPort {
  readonly adapter = 'mastra' as const;
  readonly mode = 'two_stage' as const;
  readonly model: string;
  private readonly criticAgent: Agent;
  private readonly refinerAgent: Agent;
  private readonly refinerModel: string;

  constructor(criticAgent: Agent, refinerAgent: Agent, criticModel: string, refinerModel: string) {
    this.criticAgent = criticAgent;
    this.refinerAgent = refinerAgent;
    this.model = criticModel;
    this.refinerModel = refinerModel;
  }

  async refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement> {
    const critiqueResult = await this.criticAgent.generate(buildCritiquePrompt(input), {
      structuredOutput: { schema: StrategyCritiqueSchema },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: critiqueResult.usage?.inputTokens ?? 0,
      outputTokens: critiqueResult.usage?.outputTokens ?? 0,
      totalTokens: critiqueResult.usage?.totalTokens ?? 0,
    });
    const critique = StrategyCritiqueSchema.parse(critiqueResult.object);

    const refineResult = await this.refinerAgent.generate(buildRefinePrompt(input, critique), {
      structuredOutput: { schema: RefinementDeltaSchema },
    });
    await opts?.onUsage?.({
      modelId: this.refinerModel,
      inputTokens: refineResult.usage?.inputTokens ?? 0,
      outputTokens: refineResult.usage?.outputTokens ?? 0,
      totalTokens: refineResult.usage?.totalTokens ?? 0,
    });
    const delta = RefinementDeltaSchema.parse(refineResult.object);

    return StrategyRefinementSchema.parse({
      ...critique,
      improvedStrategyText: delta.improvedStrategyText,
      changeLog: delta.changeLog,
    });
  }
}
