import { z } from 'zod';
import type { HypothesisProposalDraft } from './hypothesis.ts';
import type { StrategyProfile } from './strategy-profile.ts';

export const CriticConcernSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['info', 'warning']),
  message: z.string().min(1),
});
export type CriticConcern = z.infer<typeof CriticConcernSchema>;

export const CriticOutputSchema = z.object({
  verdict: z.enum(['ok', 'concerns']),
  concerns: z.array(CriticConcernSchema),
  summary: z.string(),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

export interface CriticInput {
  proposal: HypothesisProposalDraft;
  profile: StrategyProfile;
}

/** Persisted advisory review. Critic NEVER gates; this is audit only. */
export interface HypothesisReview {
  id: string;
  hypothesisId: string;
  criticAdapter: string;
  criticModel: string;
  verdict: 'ok' | 'concerns';
  concerns: CriticConcern[];
  summary: string;
  createdAt: string;
}
