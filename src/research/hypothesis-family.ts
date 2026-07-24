/**
 * R12b (research-validation-hardening, item 5): family-identity L1 helper. Produces the
 * `trialFamilyHint` string lab threads onto every backtester submission for a hypothesis, so the
 * backtester's trial ledger (`computeFamilyKey: hint ?? moduleRef.id`) groups every trial of a
 * hypothesis under one family instead of collapsing them into the preset's baseline moduleRef.
 *
 * L1 ONLY (YAGNI — family identity doc §authority hierarchy): the domain (`HypothesisProposal`,
 * see `../domain/hypothesis.ts`) does not currently store a lineage/root reference, so every
 * hypothesis is its own family root today (`derivedFrom` always absent → hint falls back to
 * `id`). The `derivedFrom` parameter exists so this helper is a no-op change once a future slice
 * adds real lineage — `derivedFrom` is treated as the DIRECT parent/root id (no chain-walk to a
 * true root; a repository lookup would be needed for that, which is out of scope — L1, no new
 * queries). `null`/`undefined` both mean "no lineage" and fall back to `id`.
 */
export interface HypothesisFamilyLineage {
  readonly id: string;
  readonly derivedFrom?: string | null;
}

export function hypothesisFamilyHint(h: HypothesisFamilyLineage): string {
  const rootId = h.derivedFrom ?? h.id;
  return `hypothesis:${rootId}`;
}
