import type { Agent } from '@mastra/core/agent';
import type {
  StrategyBuilder,
  StrategyBuilderInput,
  StrategyBuilderOutput,
} from '../../ports/strategy-builder.port.ts';
import type { AgentCallOpts } from '../../ports/agent-call-opts.ts';
import { StrategyLlmOutputSchema, llmToStrategyBuilderOutput } from '../../domain/strategy-llm-output.ts';
import { buildStrategyUserMessage } from './strategy-user-message.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

export class BuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderError';
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class MastraStrategyBuilder implements StrategyBuilder {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;
  private readonly maxAttempts: number;

  constructor(agent: Agent, label: string, opts?: { maxAttempts?: number }) {
    this.agent = agent;
    this.model = label;
    this.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async build(input: StrategyBuilderInput, opts?: AgentCallOpts): Promise<StrategyBuilderOutput> {
    const profile = input.profile?.profile;
    if (profile === undefined) {
      throw new BuilderError('StrategyProfile is required for MastraStrategyBuilder');
    }
    const userMsg = buildStrategyUserMessage(profile, input.feedback);

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

    throw new BuilderError(`schema-parse exhausted after ${this.maxAttempts} attempts`);
  }
}
