import type { Agent } from '@mastra/core/agent';
import type { ResultInterpreterPort, InterpretInput, AgentCallOpts } from '../../ports/wfo-agents.port.ts';
import { ResultInterpretOutputSchema, type ResultInterpretOutput } from '../../domain/wfo.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';
import { scrubMetricsBag } from '../../research/outcome-embargo.ts';

function buildPrompt(input: InterpretInput): string {
  const { scrubbed: topN } = scrubMetricsBag(input.topN);
  // R3 (report-13 gap G3): surface lone_peak as an explicit fact, not just a buried JSON field —
  // the interpreter never decides on it (informational only), but must be told plainly.
  const lonePeakHashes = topN.filter((p) => p.lonePeak).map((p) => p.paramsHash);
  const lonePeakFact = lonePeakHashes.length > 0
    ? `Lone peak (isolated result — axial neighbors far weaker; a classic overfitting signal): ${lonePeakHashes.join(', ')}`
    : 'Lone peak: none detected among ranked points.';
  return [
    `Top-N ranked results: ${JSON.stringify(topN)}`,
    lonePeakFact,
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
