// src/experiments/intent-classifier/openai-eval-schema.test.ts
import { describe, it, expect } from 'vitest';
import { ChatIntentEvalSchema } from './openai-eval-schema.ts';
import { ChatIntentSchema } from '../../chat/intent.ts';

// The fields that are `.optional()` in the prod ChatIntentSchema.
const OPTIONAL_FIELDS = ['strategyText', 'hypothesisText', 'entityRef', 'taskIdHint', 'requestedOutcome', 'rationale'] as const;

const FULL_NULL = {
  intent: 'help', confidence: 0.9,
  strategyText: null, hypothesisText: null, entityRef: null, taskIdHint: null, requestedOutcome: null, rationale: null,
};

describe('ChatIntentEvalSchema — OpenAI strict-compatible variant', () => {
  it('marks every field required (none optional) -> JSON-Schema `required` includes all keys', () => {
    // zod-to-json-schema (what Mastra uses) puts every non-optional field in `required`; OpenAI strict
    // demands exactly that. So: no field of the eval schema may be optional.
    for (const [key, field] of Object.entries(ChatIntentEvalSchema.shape)) {
      expect(field.isOptional(), `${key} must not be optional in the eval schema`).toBe(false);
    }
  });

  it('expresses the prod-optional fields as nullable (so optionality survives as type [...,"null"])', () => {
    for (const key of OPTIONAL_FIELDS) {
      expect(ChatIntentEvalSchema.shape[key]!.isNullable(), `${key} must be nullable`).toBe(true);
    }
  });

  it('accepts an object that sends null for every optional field', () => {
    expect(ChatIntentEvalSchema.safeParse(FULL_NULL).success).toBe(true);
  });

  it('requires the optional keys to be present (omitting one fails — proves they are in `required`)', () => {
    expect(ChatIntentEvalSchema.safeParse({ intent: 'help', confidence: 0.9 }).success).toBe(false);
  });

  it('keeps the same allowed intents + .strict() (rejects unknown keys and bad intents)', () => {
    expect(ChatIntentEvalSchema.safeParse({ ...FULL_NULL, intent: 'made.up' }).success).toBe(false);
    expect(ChatIntentEvalSchema.safeParse({ ...FULL_NULL, bogus: 1 }).success).toBe(false);
  });

  it('does NOT mutate the prod ChatIntentSchema (optionals stay optional; omission still allowed)', () => {
    for (const key of OPTIONAL_FIELDS) {
      expect(ChatIntentSchema.shape[key].isOptional(), `${key} must remain optional in prod`).toBe(true);
    }
    expect(ChatIntentSchema.safeParse({ intent: 'help', confidence: 0.9 }).success).toBe(true);
  });
});
