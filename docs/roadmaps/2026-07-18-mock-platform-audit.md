# Mock-platform audit — lab-local roadmap entry (2026-07-18)

Canonical cross-repo status lives in the control-center
[initiative registry](../../../control-center/docs/delivery/cross-repo-initiatives.md)
and the
[wfo-extended-fixture card](../../../control-center/docs/delivery/initiatives/wfo-extended-fixture.md)
/
[mock-contract-parity card](../../../control-center/docs/delivery/initiatives/mock-contract-parity.md);
this file keeps only lab's local slice (registry rule: no plan duplication).

Full audit: control-center
[`docs/analysis/09-mock-platform-audit.md`](../../../control-center/docs/analysis/09-mock-platform-audit.md).

## Lab's part — `proposed`

- **wfo-extended-fixture**: tier-aware fixture selection + fail-fast in the
  WFO/holdout experiment path. Today `DEFAULT_HOLDOUT_POLICY`
  (`minHistoryDays: 30`, `minTradesTrain: 50`, `minTradesHoldout: 30` —
  `src/research/holdout-boundary-resolver.ts:5-48`,
  `src/domain/research-experiment.ts:33-39`) deterministically rejects every
  committed mock fixture (longest = 6.94 days) with `insufficient_history`
  deep in the contour. The initiative adds an up-front required-history check
  that names the required fixture tier (T2 `wfo42d`) instead. Pinned-behavior
  test: T2 → holdout boundary resolved; weekly default →
  `insufficient_history`.
- **mock-contract-parity**: consumer stake only — no lab code change
  expected. `http-market-history.adapter` already sorts and dedupes by
  `minute_ts`, so lab is insensitive to the mock's multi-symbol ordering
  divergence; the range-boundary fix (P0-1) lands on the mock side.
