import { z } from 'zod';
import type { Gate1Input } from '../../ports/wfo-agents.port.ts';

export type Gate1Decision = 'improve' | 'allow_exploratory_sweep' | 'stop_not_worth' | 'stop_insufficient_evidence';

export type LabelSource = 'oracle' | 'teacher';

export interface RawCase {
  id: string;
  input: Gate1Input;
  meta: { experimentId: string; sourceRef: string };
}

export type OracleLabel = { label: Gate1Decision; confidence: 'obvious' } | { needsTeacher: true };

export interface FrozenCase {
  id: string;
  input: Gate1Input;
  label: Gate1Decision;
  labelSource: LabelSource;
  teacherModel?: string;
  rationale?: string;
  createdAt: string;
}

export interface FrozenDataset {
  snapshotId: string;
  createdAt: string;
  gitSha: string;
  sourceRef: string;
  cases: FrozenCase[];
}

export const RawCaseSchema = z.object({
  id: z.string(),
  input: z.any() as z.ZodType<Gate1Input>,
  meta: z.object({
    experimentId: z.string(),
    sourceRef: z.string(),
  }),
});
