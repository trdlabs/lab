import type { BuilderOutput } from '../../ports/builder.port.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

// ─── Eval input ────────────────────────────────────────────────────────────

export interface BuilderEvalInput {
  models: string[];
  fixtureId: string;
  fixtureFingerprint: string;
  /** Hypotheses to feed sequentially to each model */
  hypotheses: readonly HypothesisProposal[];
  profile: StrategyProfile;
  threshold: number;
  repeat: number;
}

// ─── Per-run result ─────────────────────────────────────────────────────────

export interface CheckResult {
  id: string;
  weight: number;
  /** Weighted contribution toward final score (0..weight) */
  contribution: number;
  /** Human-readable evidence strings (what matched / what failed) */
  evidence: string[];
}

export interface ScoreResult {
  /** Weighted sum / total weight ∈ [0, 1] */
  score: number;
  verdict: 'PASS' | 'FAIL';
  threshold: number;
  checks: CheckResult[];
}

export type CandidateError = {
  type: 'schema' | 'timeout' | 'provider' | 'unknown';
  message: string;
};

/** One model × one hypothesis × one repeat attempt */
export interface CandidateResult {
  model: string;
  provider: string;
  modelId: string;
  hypothesisId: string;
  latencyMs: number;
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null;
  rawOutput: BuilderOutput | null;
  error: CandidateError | null;
}

// ─── Aggregates ─────────────────────────────────────────────────────────────

export interface ModelAggregate {
  model: string;
  /** Fraction of (hypothesis × repeat) attempts that PASSed */
  passRate: number;
  scoreMean: number | null;
  latencyMeanMs: number;
  runs: { ok: number; total: number };
}

export interface BuilderEvalRunResult {
  fixture: { id: string; fingerprint: string };
  threshold: number;
  repeat: number;
  models: string[];
  perModel: CandidateResult[];
  aggregates: ModelAggregate[];
  overallSuccess: boolean;
}
