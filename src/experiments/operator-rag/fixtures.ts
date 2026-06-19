// src/experiments/operator-rag/fixtures.ts
// Loads + validates the labelled strategy-retrieval datasets shipped under __fixtures__/.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StrategyRetrievalEvalCase } from './types.ts';

const DIR = 'src/experiments/operator-rag/__fixtures__';

const FiltersSchema = z
  .object({
    market: z.string().optional(),
    symbol: z.string().optional(),
    timeframe: z.string().optional(),
    direction: z.enum(['long', 'short', 'both']).optional(),
  })
  .strict();

export const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    query: z.string().min(1),
    language: z.enum(['ru', 'en', 'mixed']),
    filters: FiltersSchema,
    expectedRelevantIds: z.array(z.string()),
    gradedRelevance: z.record(z.string(), z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])),
    expectedExactId: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // expectedExactId (when present) must also appear in expectedRelevantIds
    if (val.expectedExactId != null && !val.expectedRelevantIds.includes(val.expectedExactId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expectedExactId "${val.expectedExactId}" must be in expectedRelevantIds`,
        path: ['expectedExactId'],
      });
    }
    // All expectedRelevantIds should have an entry in gradedRelevance >= 1
    for (const rid of val.expectedRelevantIds) {
      const grade = val.gradedRelevance[rid];
      if (grade === undefined || grade === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expectedRelevantId "${rid}" must have gradedRelevance >= 1`,
          path: ['gradedRelevance'],
        });
      }
    }
  });

export const DatasetSchema = z.array(EvalCaseSchema);

export const DATASETS: Record<string, string> = {
  'strategy-retrieval-v1': `${DIR}/strategy-retrieval-v1.json`,
};

export function resolveDataset(id: string): string {
  const path = DATASETS[id];
  if (!path) throw new Error(`unknown dataset "${id}" (known: ${Object.keys(DATASETS).join(', ')})`);
  return path;
}

export function loadCases(id: string): StrategyRetrievalEvalCase[] {
  const path = resolveDataset(id);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`failed to read dataset "${id}" at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = DatasetSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`dataset "${id}" failed validation:\n${result.error.toString()}`);
  }
  const cases = result.data as StrategyRetrievalEvalCase[];

  // Duplicate-id guard
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate case id "${c.id}" in dataset ${id}`);
    seen.add(c.id);
  }
  return cases;
}

export function fingerprintCases(cases: StrategyRetrievalEvalCase[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(cases), 'utf8').digest('hex')}`;
}
