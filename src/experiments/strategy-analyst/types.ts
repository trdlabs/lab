// src/experiments/strategy-analyst/types.ts
import { z } from 'zod';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';

export type EvalMode = 'dry-run' | 'run';

export interface FixtureRef {
  readonly id: string;
  readonly sourcePath?: string;   // prose source (manual_description/readme/article)
  readonly sourceDir?: string;    // multi-file code dir (bot_code) — gathered at read time
  readonly kind?: 'manual_description' | 'bot_code';
  readonly notesPath: string;
  readonly rubricPath: string;
  readonly direction: 'long' | 'short';
}

export interface CheckResult {
  id: string;
  weight: number;
  bucketsHit: number;
  bucketCount: number;
  contribution: number;
  matched: string[];
}

export interface ScoreResult {
  gates: { schemaValid: boolean; directionLong?: boolean; directionMatches?: boolean };
  checks: CheckResult[];
  score: number; // 0..1 — always a number; scoreProfile only runs when a raw object exists
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
  missingFromProfile: z.array(z.string()),
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CandidateResult {
  model: string;
  provider: string;
  modelId: string;
  latencyMs: number;
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null;        // primary deterministic signal — scoreCompleteness (null only when analyze() threw)
  secondaryScore: ScoreResult | null; // bespoke long-oi scoreProfile diagnostic; null unless direction === 'long'
  rawOutput: AnalystProfileOutput | null; // present only when analyze() returned
  error: CandidateError | null;
  judge: JudgeVerdict | null;       // populated only when --judge ran; written to a SEPARATE file
}

export interface Stats {
  mean: number;
  median: number;
  std: number; // population std (divide by n); n === 1 -> 0
  min: number;
  max: number;
}

export interface ModelAggregate {
  model: string;
  provider: string;
  modelId: string;
  runs: { total: number; ok: number; failed: number; failedByType: Record<string, number> };
  passRate: number;            // PASS count / total runs (failed runs count as non-PASS)
  det: Stats | null;           // over runs with a deterministic score (analyze() returned)
  judge: Stats | null;         // over runs with a judge verdict; null if judge never ran
  latency: { mean: number; median: number }; // over all runs
}

export interface EvalRunResult {
  fixture: { id: string; fingerprint: string };
  threshold: number;
  repeat: number;
  judgeEnabled: boolean;
  models: string[];
  perModel: CandidateResult[];   // flat: every run, ordered model-major then run index
  aggregates: ModelAggregate[];  // one per model
  overallSuccess: boolean;       // >=1 run (any model) with verdict PASS
}

export interface ManifestMeta {
  timestamp: string;
  gitSha: string;
  harnessVersion: string;
  contractVersion: string;
  mode: EvalMode;
}
