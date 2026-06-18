import { z } from 'zod';
import { ChatIntentSchema } from './intent.ts';

/**
 * OpenAI / OpenRouter strict structured outputs require every property in `required`,
 * with optionality expressed as nullable (`type: [..., "null"]`) rather than omitting keys.
 * Zod `.optional()` drops keys from `required`, which Anthropic tolerates but OpenAI-compatible
 * providers reject before the request is sent ("Missing 'strategyText'").
 *
 * Derived from ChatIntentSchema.shape so prod and provider wire shapes cannot drift.
 */
function nullableizeOptionals(shape: z.ZodRawShape): z.ZodRawShape {
  const out: z.ZodRawShape = {};
  for (const [key, field] of Object.entries(shape)) {
    out[key] = field instanceof z.ZodOptional ? field.unwrap().nullable() : field;
  }
  return out;
}

export const ChatIntentProviderSchema = z.object(nullableizeOptionals(ChatIntentSchema.shape)).strict();
