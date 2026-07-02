import type { Agent } from '@mastra/core/agent';
import type { SweepDesignerPort, SweepInput, AgentCallOpts } from '../../ports/wfo-agents.port.ts';
import { SweepDesignOutputSchema, type SweepDesignOutput } from '../../domain/wfo.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

function buildPrompt(input: SweepInput): string {
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Baseline train metrics: ${JSON.stringify(input.baselineTrainSummary)}`,
    `Tunable params: ${JSON.stringify(input.tunableParams)}`,
    `Restrict to entry-affecting params only: ${input.restrictToEntryParams}`,
    `Period end (T, no data beyond this): ${input.periodTo}`,
    `Max grid points: ${input.maxPoints}`,
  ].join('\n');
}

export class MastraSweepDesigner implements SweepDesignerPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async design(input: SweepInput, opts?: AgentCallOpts): Promise<SweepDesignOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: SweepDesignOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    return SweepDesignOutputSchema.parse(result.object);
  }
}
