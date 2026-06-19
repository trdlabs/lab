import { z } from 'zod';
import { TurnInterpretationSchema } from './turn-interpretation.ts';

/**
 * OpenAI / OpenRouter strict structured outputs require every property in `required`,
 * with optionality expressed as nullable (`type: [..., "null"]`) rather than omitting keys.
 * Zod `.optional()` drops keys from `required`, which Anthropic tolerates but OpenAI-compatible
 * providers reject before the request is sent.
 *
 * Derived from TurnInterpretationSchema.shape so prod and provider wire shapes cannot drift.
 * The nested `constraints` object gets its own nullableized inner shape for the same reason.
 */
function nullableizeOptionals(shape: z.ZodRawShape): z.ZodRawShape {
  const out: z.ZodRawShape = {};
  for (const [key, field] of Object.entries(shape)) {
    out[key] = field instanceof z.ZodOptional ? field.unwrap().nullable() : field;
  }
  return out;
}

// Nullableize the inner constraints shape so nested optional fields become required+nullable.
const constraintsInner = (TurnInterpretationSchema.shape.constraints as z.ZodObject<z.ZodRawShape>).shape;
const nullableConstraints = z.object(nullableizeOptionals(constraintsInner)).strict();

// Build the top-level provider schema: optionals become required+nullable, constraints replaced.
const topShape = nullableizeOptionals({
  ...TurnInterpretationSchema.shape,
  constraints: TurnInterpretationSchema.shape.constraints,
});
topShape['constraints'] = nullableConstraints;

export const TurnProviderSchema = z.object(topShape).strict();
