import type { Agent } from '@mastra/core/agent';
import type { ZodTypeAny } from 'zod';
import type { IntentClassifierPort } from '../../ports/intent-classifier.port.ts';
import { ChatIntentSchema } from '../../chat/intent.ts';
import { ChatIntentProviderSchema } from '../../chat/intent-provider-schema.ts';
import { withoutNullProps } from '../../chat/normalize-intent-output.ts';

function buildPrompt(message: string): string {
  return `Classify the following user message.\n\n--- USER MESSAGE START ---\n${message}\n--- USER MESSAGE END ---\n\nReturn the structured intent.`;
}

/** Best-effort recovery of the raw model JSON from the unstructured text channel. */
function parseRawText(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  return text; // last resort: hand the raw string back; the ChatIntentSchema gate marks it invalid
}

export interface MastraIntentClassifierOptions {
  /**
   * How the structured output is validated.
   * - `'strict'` (default) — PRODUCTION behaviour, unchanged: Mastra validates against
   *   ChatIntentSchema inside generate() and throws STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED on
   *   any deviation.
   * - `'raw'` — EVAL only: `errorStrategy: 'warn'` makes generate() log + continue instead of
   *   throwing, and classify() returns the raw model output (recovered from `result.text` when a
   *   deviation leaves `result.object` empty). The harness/guard's ChatIntentSchema gate stays the
   *   single trust boundary, so a deviation is scored as a per-case schema-invalid miss with the
   *   model's intent still visible — never a bald throw that kills the run.
   */
  schemaValidation?: 'strict' | 'raw';
  /**
   * Schema sent to the model for structured output in the `'raw'` (eval) path. Lets the eval layer
   * pass an OpenAI-strict-compatible variant (every key required + optionals nullable) without
   * changing the prod ChatIntentSchema. Defaults to ChatIntentSchema. Ignored in `'strict'` mode,
   * so the production request stays byte-identical.
   */
  requestSchema?: ZodTypeAny;
}

export class MastraIntentClassifier implements IntentClassifierPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;
  private readonly schemaValidation: 'strict' | 'raw';
  private readonly requestSchema: ZodTypeAny;

  constructor(agent: Agent, label: string, options: MastraIntentClassifierOptions = {}) {
    this.agent = agent;
    this.model = label;
    this.schemaValidation = options.schemaValidation ?? 'strict';
    this.requestSchema = options.requestSchema ?? ChatIntentSchema;
  }

  async classify(message: string): Promise<unknown> {
    if (this.schemaValidation === 'strict') {
      // PRODUCTION path — OpenAI-compatible providers require all keys in `required` (nullable).
      const result = await this.agent.generate(buildPrompt(message), {
        structuredOutput: { schema: ChatIntentProviderSchema },
      });
      // Normalize null optionals -> absent; the guard re-validates against ChatIntentSchema.
      return withoutNullProps(result.object);
    }

    // EVAL path — never let Mastra's internal zod gate throw; the harness re-validates. Uses
    // requestSchema (OpenAI-strict-compatible variant) so providers that demand all-keys-required
    // don't reject the request; absent fields come back as null and are normalized before the gate.
    const result: { object?: unknown; text?: unknown } = await this.agent.generate(buildPrompt(message), {
      structuredOutput: { schema: this.requestSchema, errorStrategy: 'warn' },
    });
    const raw = result.object != null ? result.object : parseRawText(result.text);
    return withoutNullProps(raw);
  }
}
