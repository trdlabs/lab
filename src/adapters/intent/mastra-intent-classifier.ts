import type { Agent } from '@mastra/core/agent';
import type { IntentClassifierPort } from '../../ports/intent-classifier.port.ts';
import { ChatIntentSchema } from '../../chat/intent.ts';

function buildPrompt(message: string): string {
  return `Classify the following user message.\n\n--- USER MESSAGE START ---\n${message}\n--- USER MESSAGE END ---\n\nReturn the structured intent.`;
}

export class MastraIntentClassifier implements IntentClassifierPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async classify(message: string): Promise<unknown> {
    const result = await this.agent.generate(buildPrompt(message), {
      structuredOutput: { schema: ChatIntentSchema },
    });
    // Return raw object; the guard's schema gate is the trust boundary.
    return result.object;
  }
}
