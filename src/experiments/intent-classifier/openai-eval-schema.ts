// src/experiments/intent-classifier/openai-eval-schema.ts
// OpenAI strict structured outputs require EVERY property to appear in `required`, with optionality
// expressed as nullable (type [...,"null"]) rather than by omitting the key. Zod's `.optional()`
// drops the key from `required`, which Google/DeepSeek tolerate but OpenAI rejects at validation
// (400 "Invalid schema for response_format: 'required' ... Missing 'strategyText'", instant 0/20).
//
// This EVAL-ONLY schema is derived from the PROD ChatIntentSchema (src/chat/intent.ts) by turning
// every `.optional()` field into a `.nullable()` one (still required). It is sent to OpenAI-compatible
// providers in the eval path only. The prod schema is untouched and the harness still re-validates
// model output through it. Contract semantics are unchanged — those fields remain optional; only the
// wire representation handed to the provider changes. Deriving from ChatIntentSchema.shape guarantees
// the eval variant can never drift from prod.
import { z } from 'zod';
import { ChatIntentSchema } from '../../chat/intent.ts';

/** Replace each `.optional()` field with a required-but-`.nullable()` one; leave the rest as-is. */
function nullableizeOptionals(shape: z.ZodRawShape): z.ZodRawShape {
  const out: z.ZodRawShape = {};
  for (const [key, field] of Object.entries(shape)) {
    out[key] = field instanceof z.ZodOptional ? field.unwrap().nullable() : field;
  }
  return out;
}

export const ChatIntentEvalSchema = z.object(nullableizeOptionals(ChatIntentSchema.shape)).strict();
