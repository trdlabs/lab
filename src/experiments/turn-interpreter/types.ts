// src/experiments/turn-interpreter/types.ts
// Shared contracts for the TurnInterpreter eval harness. Symmetrical to
// src/experiments/intent-classifier/types.ts but role-specific: the unit of work is a
// labelled operator-turn dataset, and the headline metric is subject+field accuracy.
import { z } from 'zod';
import { SUBJECTS, TURN_GOALS } from '../../chat/turn-interpretation.ts';

export type Subject = (typeof SUBJECTS)[number];
export type TurnGoal = (typeof TURN_GOALS)[number];
export type ConstraintField = 'market' | 'symbol' | 'timeframe' | 'direction';

export interface EvalCaseExpect {
  subject: Subject;                          // primary, always scored
  goal?: TurnGoal | 'none';                  // 'none' = expected absent
  hasStrategyText?: boolean;                 // presence, not content
  constraints?: {
    market?: string;
    symbol?: string;
    timeframe?: string;
    direction?: 'long' | 'short' | 'both';
  };
  absentConstraints?: ConstraintField[];     // must NOT be fabricated
  references?: string[];                     // set match when declared
}

export interface EvalCase {
  id: string;
  lang: 'ru' | 'en';
  message: string;
  expect: EvalCaseExpect;
}

export type ScoredField =
  | 'subject'
  | 'goal'
  | 'direction'
  | 'market'
  | 'symbol'
  | 'timeframe'
  | 'strategyText'
  | 'references';

export interface CaseResult {
  id: string;
  lang: 'ru' | 'en';
  schemaValid: boolean;
  score: number;                             // 0..1
  latencyMs: number;
  fields: Partial<Record<ScoredField, number>>; // per-declared-field 0/1
  fabricatedCount: number;
  subject: string;                           // parsed subject or best-effort
}

export interface ScoreResult {
  schemaValidRate: number;
  subjectAccuracy: number;
  fieldAccuracies: Partial<Record<ScoredField, number>>;
  fabricationRate: number;                   // share of cases with >=1 fabrication
  score: number;                             // mean caseScore
  threshold: number;
  verdict: 'PASS' | 'FAIL';
  cases: CaseResult[];
}

export const JudgeVerdictSchema = z.object({
  dimensions: z.array(
    z.object({ name: z.string(), score: z.number(), rationale: z.string() }),
  ),
  overallScore: z.number(),
  hallucinations: z.array(z.string()),
  missingFromExpected: z.array(z.string()),
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CandidateResult {
  modelId: string;
  provider: string;
  ok: boolean;
  error?: string;
  result?: ScoreResult;
  judge?: JudgeVerdict[];
}

export interface ModelAggregate {
  modelId: string;
  provider: string;
  runs: number;
  meanScore: number;
  passRate: number;
  meanLatencyMs: number;
  judgeMean?: number;
}

export interface ManifestMeta {
  datasetId: string;
  datasetFingerprint: string;
  models: string[];
  repeat: number;
  threshold: number;
  caseCount: number;
  judgeEnabled: boolean;
}

export interface EvalRunResult {
  manifest: ManifestMeta;
  candidates: CandidateResult[];
  aggregates: ModelAggregate[];
}
