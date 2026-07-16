import type { Agent } from '@mastra/core/agent';
import type { Gate1DecisionPort, Gate1Input, AgentCallOpts } from '../../ports/wfo-agents.port.ts';
import { Gate1OutputSchema, type Gate1Output } from '../../domain/wfo.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';
import { scrubMetricsBag } from '../../research/outcome-embargo.ts';

function buildPrompt(input: Gate1Input): string {
  // Outcome Embargo: last-point-before-LLM scrub (silent belt; the experiment-service
  // seam emits the outcome_embargo.scrubbed evidence event).
  const { scrubbed: baselineMetrics } = scrubMetricsBag(input.baselineMetrics);
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Baseline train metrics: ${JSON.stringify(baselineMetrics)}`,
    `Entry-affecting tunable params: ${JSON.stringify(input.entryAffecting)}`,
    `Has entry-signal evidence: ${input.hasEntrySignalEvidence}`,
  ].join('\n');
}

export class MastraGate1 implements Gate1DecisionPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async decide(input: Gate1Input, opts?: AgentCallOpts): Promise<Gate1Output> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: Gate1OutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    return Gate1OutputSchema.parse(result.object);
  }
}
