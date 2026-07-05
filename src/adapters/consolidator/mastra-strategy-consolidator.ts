import type { Agent } from '@mastra/core/agent';
import type { StrategyBuilderOutput } from '../../ports/strategy-builder.port.ts';
import type { StrategyConsolidatorPort, StrategyConsolidateArgs } from '../../ports/strategy-consolidator.port.ts';
import type { AgentCallOpts } from '../../ports/agent-call-opts.ts';
import { StrategyLlmOutputSchema, llmToStrategyBuilderOutput } from '../../domain/strategy-llm-output.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

/** Builds the user message: stacked source + mergedRuleSet given as reference material, not to be altered. */
function renderConsolidationPrompt(args: StrategyConsolidateArgs): string {
  const sections = [
    'Rewrite the composed strategy below into ONE flat, self-contained `export default function` factory with IDENTICAL behavior.',
    'Add, remove, or alter NO rule or condition. No imports.',
    '',
    '## Composed source (reference — preserve behavior exactly)',
    '```ts',
    args.stackedSource,
    '```',
    '',
    '## Merged rule set (reference — every rule must remain present and unchanged)',
    '```json',
    JSON.stringify(args.mergedRuleSet, null, 2),
    '```',
  ];
  if (args.theses) {
    sections.push(
      '',
      '## Theses (context only, non-normative)',
      '```json',
      JSON.stringify(args.theses, null, 2),
      '```',
    );
  }
  return sections.join('\n');
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class ConsolidatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsolidatorError';
  }
}

export class MastraStrategyConsolidator implements StrategyConsolidatorPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;
  private readonly maxAttempts: number;

  constructor(agent: Agent, label: string, opts?: { maxAttempts?: number }) {
    this.agent = agent;
    this.model = label;
    this.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async consolidate(args: StrategyConsolidateArgs, opts?: AgentCallOpts): Promise<StrategyBuilderOutput> {
    const userMsg = renderConsolidationPrompt(args);

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const result = await this.agent.generate(userMsg, {
        structuredOutput: { schema: StrategyLlmOutputSchema },
        modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      });
      await opts?.onUsage?.({
        modelId: this.model,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
      });
      try {
        return llmToStrategyBuilderOutput(StrategyLlmOutputSchema.parse(result.object));
      } catch {
        continue;
      }
    }

    throw new ConsolidatorError(`schema-parse exhausted after ${this.maxAttempts} attempts`);
  }
}
