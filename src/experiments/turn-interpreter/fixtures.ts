// src/experiments/turn-interpreter/fixtures.ts
// Loads + validates the labelled turn-interpretation datasets shipped under __fixtures__/.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SUBJECTS, TURN_GOALS } from '../../chat/turn-interpretation.ts';
import type { EvalCase } from './types.ts';

const DIR = 'src/experiments/turn-interpreter/__fixtures__';

const ExpectSchema = z
  .object({
    subject: z.enum(SUBJECTS),
    goal: z.union([z.enum(TURN_GOALS), z.literal('none')]).optional(),
    hasStrategyText: z.boolean().optional(),
    constraints: z
      .object({
        market: z.string().min(1).optional(),
        symbol: z.string().min(1).optional(),
        timeframe: z.string().min(1).optional(),
        direction: z.enum(['long', 'short', 'both']).optional(),
      })
      .strict()
      .optional(),
    absentConstraints: z
      .array(z.enum(['market', 'symbol', 'timeframe', 'direction']))
      .optional(),
    references: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    lang: z.enum(['ru', 'en']),
    message: z.string().min(1),
    expect: ExpectSchema,
  })
  .strict();

export const DatasetSchema = z.object({
  version: z.string().min(1),
  cases: z.array(EvalCaseSchema).min(1),
});

export const DATASETS: Record<string, string> = {
  'turn-interpretations-v1': `${DIR}/turn-interpretations-v1.json`,
};

export function resolveDataset(id: string): string {
  const path = DATASETS[id];
  if (!path) throw new Error(`unknown dataset "${id}" (known: ${Object.keys(DATASETS).join(', ')})`);
  return path;
}

export function loadCases(id: string): EvalCase[] {
  const path = resolveDataset(id);
  const parsed = DatasetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const seen = new Set<string>();
  for (const c of parsed.cases) {
    if (seen.has(c.id)) throw new Error(`duplicate case id "${c.id}" in dataset ${id}`);
    seen.add(c.id);
  }
  return parsed.cases;
}

export function fingerprintCases(cases: EvalCase[]): string {
  const canonical = JSON.stringify(
    cases.map((c) => ({ id: c.id, lang: c.lang, message: c.message, expect: c.expect })),
  );
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
