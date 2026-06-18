import type { Agent } from '@mastra/core/agent';
import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';
import { TurnProviderSchema } from '../../chat/turn-provider-schema.ts';

function buildPrompt(message: string): string {
  return `Interpret the following user message and extract structured turn information.\n\n--- USER MESSAGE START ---\n${message}\n--- USER MESSAGE END ---\n\nReturn the structured turn interpretation.`;
}

/**
 * Production turn interpreter using Mastra structured output.
 * ONE prompt + ONE structured-output request, NO tools.
 * Returns raw provider output (may contain nulls for absent optionals).
 * Callers must run normalizeTurnOutput then TurnInterpretationSchema.parse.
 */
export class MastraTurnInterpreter implements TurnInterpreterPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;

  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async interpret(message: string): Promise<unknown> {
    const result = await this.agent.generate(buildPrompt(message), {
      structuredOutput: { schema: TurnProviderSchema },
    });
    return result.object;
  }
}
