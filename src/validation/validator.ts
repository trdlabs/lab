import type { ZodTypeAny } from 'zod';
import type { ValidationIssue, ValidationResult } from '../domain/schemas.ts';

/** Schema gate (gate #1 in design §12): validate unknown input against a Zod schema. */
export function validateWithSchema(schema: ZodTypeAny, input: unknown): ValidationResult {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { status: 'valid', issues: [] };

  const issues: ValidationIssue[] = parsed.error.issues
    .map((i) => ({
      code: 'schema_violation',
      severity: 'error' as const,
      path: i.path.join('.'),
      message: i.message,
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));

  return { status: 'invalid', issues };
}
