import type { Agent } from '@mastra/core/agent';
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import { AnalystProfileOutputSchema, type AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

const CODE_ANALYSIS_GUIDANCE =
  'The SOURCE below is the COMPLETE implementation of a trading strategy (one or more files, each ' +
  'delimited by a `// ===== FILE: <path> =====` marker). Extract an EXACT, exhaustive profile: every ' +
  'parameter default, numeric threshold, window length, index offset, gate condition, and the precise ' +
  'comparison/formula. Capture fine-grained gates (warmup bar count, OI-recovery percent over N buckets, ' +
  'liquidation minima and liq/OI ratios, dump-quality filters, off-by-one indexing). Do NOT approximate ' +
  'or summarize — a builder must reproduce the EXACT runtime behavior from this profile. Put ' +
  'genuinely-absent details in `unknowns`.';

export function buildPrompt(input: StrategyAnalystInput): string {
  const header =
    `Source kind: ${input.kind}` +
    (input.title ? `\nTitle: ${input.title}` : '') +
    (input.uri ? `\nURI: ${input.uri}` : '');
  const guidance = input.kind === 'bot_code' ? `\n\n${CODE_ANALYSIS_GUIDANCE}` : '';
  return `${header}${guidance}\n\n--- SOURCE START ---\n${input.content}\n--- SOURCE END ---\n\nReturn the structured strategy profile.`;
}

export class MastraStrategyAnalyst implements StrategyAnalystPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async analyze(input: StrategyAnalystInput): Promise<AnalystProfileOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: AnalystProfileOutputSchema },
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    // Re-parse to guarantee the typed shape regardless of the SDK's inferred return type.
    return AnalystProfileOutputSchema.parse(result.object);
  }
}
