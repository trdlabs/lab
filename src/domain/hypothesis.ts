// src/domain/hypothesis.ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OVERLAY_ACTIONS } from './hypothesis-rules.ts';
import { DIRECTIONS } from './strategy-profile.ts';
import { canonicalizeContent } from './fingerprint.ts';
import type { ValidationIssue } from './schemas.ts';
import type { ResearcherFocus } from '../ports/researcher.port.ts';
import type { BreakBatteryReport } from '../research/break-battery.ts';

export const HypothesisRuleSchema = z.object({
  when: z.string().min(1),
  action: z.enum(OVERLAY_ACTIONS),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  rationale: z.string().optional(),
});
export type HypothesisRule = z.infer<typeof HypothesisRuleSchema>;

export const RuleActionSchema = z.object({
  appliesTo: z.enum(DIRECTIONS),
  rules: z.array(HypothesisRuleSchema).min(1),
});
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const ExpectedEffectSchema = z.object({
  metric: z.string().min(1),
  direction: z.enum(['increase', 'decrease']),
  magnitude: z.string().optional(),
});
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;

export const HypothesisProposalDraftSchema = z.object({
  thesis: z.string().min(1),
  targetBehavior: z.string().min(1),
  ruleAction: RuleActionSchema,
  requiredFeatures: z.array(z.string()),
  validationPlan: z.string().min(1),
  expectedEffect: ExpectedEffectSchema,
  invalidationCriteria: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});
export type HypothesisProposalDraft = z.infer<typeof HypothesisProposalDraftSchema>;

export const ResearcherOutputSchema = z.object({
  hypotheses: z.array(HypothesisProposalDraftSchema),
  researchSummary: z.string(),
});
export type ResearcherOutput = z.infer<typeof ResearcherOutputSchema>;

export const HYPOTHESIS_PROPOSAL_CONTRACT_VERSION = 'hypothesis-proposal-v1';

// 'proxy_*' statuses come from a fast, cheap, single-fold backtest signal. They are a cheap
// early read, NOT a validated/confirmed outcome — that stronger claim is only earned by a
// later paper/live promotion (outside this slice).
export type HypothesisStatus = 'validated' | 'rejected'
  | 'proxy_passed' | 'proxy_failed' | 'proxy_paper_candidate'
  | 'merged' | 'dropped_merge_conflict' | 'dropped_combo_fail' | 'dropped_unsupported_shape';

/** Proxy-signal feedback recorded from a backtest.completed evaluation decision. */
export interface HypothesisProxyMetrics {
  decision: 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';
  deltaNetPnlUsd: number;
  deltaMaxDrawdownPct: number;
  backtestRunId: string;
}

export interface HypothesisProposal {
  id: string;
  strategyProfileId: string;
  thesis: string;
  targetBehavior: string;
  ruleAction: RuleAction;
  requiredFeatures: string[]; // normalized
  validationPlan: string;
  expectedEffect: ExpectedEffect;
  invalidationCriteria: string[];
  confidence: number;
  status: HypothesisStatus;
  fingerprint: string;
  proposal: HypothesisProposalDraft; // full original draft
  issues: ValidationIssue[]; // [] for validated; reasons for rejected
  contractVersion: string;
  origin?: ResearcherFocus; // which research pass produced this; undefined for legacy single-pass
  proxyMetrics?: HypothesisProxyMetrics; // set by backtestCompletedHandler's proxy status update
  /** R12a (research-validation-hardening item 5a): full log-only `break_battery@1` report from the
   *  hypothesis-level holdout confirmation (`hypothesis.holdout` task). Advisory persistence lane
   *  only — never gates status/verdict. Absent until a holdout run completes for this hypothesis. */
  holdoutBattery?: BreakBatteryReport;
  createdAt: string;
  updatedAt: string;
}

/** Advisory similarity hit (lexical in MVP, pgvector later). Never gates. */
export interface SimilarHypothesisSummary {
  hypothesisId: string;
  thesis: string;
  status: HypothesisStatus;
  score: number;
}

/** Deterministic JSON with sorted object keys, so fingerprints ignore key ordering. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Exact-dedupe fingerprint over canonical thesis + canonical ruleAction. */
export function hypothesisFingerprint(thesis: string, ruleAction: RuleAction): string {
  const sep = '\u0000'; // explicit NUL separator (escape sequence — no raw NUL byte in source)
  const canonicalThesis = canonicalizeContent(thesis);
  const canonicalRule = canonicalizeContent(stableStringify(ruleAction));
  const hex = createHash('sha256').update(`${canonicalThesis}${sep}${canonicalRule}`, 'utf8').digest('hex');
  return `sha256:${hex}`;
}
