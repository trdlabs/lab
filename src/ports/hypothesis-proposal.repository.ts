import type { HypothesisProposal, HypothesisStatus, HypothesisProxyMetrics } from '../domain/hypothesis.ts';
import type { BreakBatteryReport } from '../research/break-battery.ts';

export interface HypothesisProposalRepository {
  create(proposal: HypothesisProposal): Promise<void>;
  findById(id: string): Promise<HypothesisProposal | null>;
  listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]>;
  listFingerprints(strategyProfileId: string): Promise<string[]>;
  /**
   * Latest VALIDATED proposal for a resolved profile (session-scoped, not global).
   * Deterministic order: createdAt DESC, id DESC. "Latest", not "best" — ranking is
   * out of scope. Canonical source of truth for hypothesis existence stays here.
   */
  findLatestValidatedByProfile(strategyProfileId: string): Promise<HypothesisProposal | null>;
  /** Updates status (+ optional proxyMetrics). Throws, naming the id, when it doesn't exist. */
  updateStatus(id: string, status: HypothesisStatus, proxyMetrics?: HypothesisProxyMetrics): Promise<void>;
  /**
   * R12a: persists the log-only holdout `break_battery@1` report onto the proposal WITHOUT touching
   * `status` — the hypothesis-holdout confirmation never mutates any verdict/status. Throws, naming
   * the id, when the proposal doesn't exist.
   */
  recordHoldoutBattery(id: string, report: BreakBatteryReport): Promise<void>;
}
