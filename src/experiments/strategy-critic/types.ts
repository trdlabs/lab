// src/experiments/strategy-critic/types.ts
import { z } from 'zod';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';

export type Direction = 'long' | 'short';
export type EvalMode = 'dry-run' | 'run';

/** A data-grounded expected improvement. Satisfied when ANY of `any` (regex sources) matches (case-insensitive). */
export interface AspectGroup {
  label: string;
  weight: number;
  any: string[];
}

export interface CriticEvalCase {
  id: string;
  text: string;
  lang: 'ru' | 'en';
  direction: Direction;
  expectedAspects: AspectGroup[];
}

export type Candidate =
  | { mode: 'single'; label: string; combinedModel: string }
  | { mode: 'two_stage'; label: string; criticModel: string; refinerModel: string };

export interface CheckResult {
  id: string;
  weight: number;
  hit: boolean;
  matched: string[];
}

export interface ScoreResult {
  gates: { schemaValid: boolean; directionPreserved: boolean; noRunnerOverreach: boolean; nonTrivialChange: boolean };
  checks: CheckResult[];
  score: number; // 0..1 weighted aspect coverage
  threshold: number;
  verdict: 'PASS' | 'FAIL';
}

export type CandidateErrorType = 'schema' | 'provider' | 'adapter' | 'timeout' | 'unknown';
export interface CandidateError {
  type: CandidateErrorType;
  message: string;
}

export const JudgeVerdictSchema = z.object({
  dimensions: z.array(z.object({ name: z.string(), score: z.number().min(0).max(1), rationale: z.string() })),
  overallScore: z.number().min(0).max(1),
  hallucinations: z.array(z.string()),
  missing: z.array(z.string()),
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CandidateResult {
  label: string;
  mode: 'single' | 'two_stage';
  criticModel: string;
  refinerModel: string | null; // null for single
  caseId: string;
  latencyMs: number;
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null;            // null only when refine() threw
  rawOutput: StrategyRefinement | null; // present only when refine() returned
  error: CandidateError | null;
  judge: JudgeVerdict | null;           // populated only when --judge ran
}

export interface Stats {
  mean: number;
  median: number;
  std: number; // population std; n === 1 -> 0
  min: number;
  max: number;
}

export interface ModelAggregate {
  label: string;
  mode: 'single' | 'two_stage';
  criticModel: string;
  refinerModel: string | null;
  runs: { total: number; ok: number; failed: number; failedByType: Record<string, number> };
  passRate: number;
  det: Stats | null;
  judge: Stats | null;
  latency: { mean: number; median: number };
}

export interface EvalRunResult {
  threshold: number;
  repeat: number;
  judgeEnabled: boolean;
  candidates: Candidate[];
  cases: string[]; // case ids
  perCandidate: CandidateResult[]; // flat: every run, candidate-major then case then run index
  aggregates: ModelAggregate[];    // one per candidate (keyed by label)
  overallSuccess: boolean;         // >=1 run (any candidate) with verdict PASS
}

export interface ManifestMeta {
  timestamp: string;
  gitSha: string;
  harnessVersion: string;
  contractVersion: string;
  mode: EvalMode;
}
