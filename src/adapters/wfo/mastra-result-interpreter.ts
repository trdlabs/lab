import type { Agent } from '@mastra/core/agent';
import type { ResultInterpreterPort, InterpretInput, AgentCallOpts } from '../../ports/wfo-agents.port.ts';
import { ResultInterpretOutputSchema, type ResultInterpretOutput } from '../../domain/wfo.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

function buildPrompt(input: InterpretInput): string {
  return [
    `Top-N ranked results: ${JSON.stringify(input.topN)}`,
    `Period end (T, no data beyond this — no-leakage boundary): ${input.periodTo}`,
    `Rounds so far: ${input.roundsSoFar}`,
    `Max rounds: ${input.maxRounds}`,
  ].join('\n');
}

export class MastraResultInterpreter implements ResultInterpreterPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async interpret(input: InterpretInput, opts?: AgentCallOpts): Promise<ResultInterpretOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: ResultInterpretOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    return ResultInterpretOutputSchema.parse(result.object);
  }
}
