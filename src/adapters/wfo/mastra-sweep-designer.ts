import type { Agent } from '@mastra/core/agent';
import type { SweepDesignerPort, SweepInput, AgentCallOpts } from '../../ports/wfo-agents.port.ts';
import { SweepDesignOutputSchema, type SweepDesignOutput } from '../../domain/wfo.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';
import { scrubMetricsBag } from '../../research/outcome-embargo.ts';

function buildPrompt(input: SweepInput): string {
  const { scrubbed: baselineTrainSummary } = scrubMetricsBag(input.baselineTrainSummary);
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Baseline train metrics: ${JSON.stringify(baselineTrainSummary)}`,
    `Tunable params: ${JSON.stringify(input.tunableParams)}`,
    `Restrict to entry-affecting params only: ${input.restrictToEntryParams}`,
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
