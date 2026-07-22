# Lab — asymmetric scaling (cross-repo, 2026-07-23)

Canonical status lives in the control-center initiative registry — local status
only, no plan duplication:
[asymmetric-scaling](../../../control-center/docs/delivery/initiatives/asymmetric-scaling.md)
(`proposed`). Full analysis: control-center
[`docs/analysis/11-scaling-architecture.md`](../../../control-center/docs/analysis/11-scaling-architecture.md).

Lab part. Key finding of the analysis: `LAB_QUEUE_CONCURRENCY=1` is an env
default, not an architectural limit — the BullMQ/Redis queue with the PG
`dedupe_key` unique index, the queued-orphan reconciler, and the
resumeToken/webhook backtester seam are already concurrency-safe.

- **S0 (config only, actionable now):** raise `LAB_QUEUE_CONCURRENCY` /
  `LAB_REVISION_QUEUE_CONCURRENCY` to 2, observing LLM 429s and token budgets
  (gate: a task batch at concurrency 2 with 429/backoff counts recorded).
- **Toward N instances:** move `LocalFileArtifactStore` (`.artifacts`, local
  FS — the main blocker) to S3/shared storage (the backtester's S3 store is
  the pattern); move `ChatRateLimiter` state to Redis (today in-process, would
  become per-instance). Everything else is already multi-instance-safe (PG
  state, BullMQ locks, PG LISTEN/NOTIFY event stream).
- **The real ceiling is LLM provider quotas, not CPU:** one API key per
  provider, no global rate limiter/pool. Scaling processes does not raise the
  provider limit — an LLM key pool / multi-provider quota spread with a
  Redis-backed limiter does.
- **S5 (B2C, strictly after `b2c-f1-tenancy`):** per-tenant lanes /
  round-robin so one tenant's 50 tasks cannot freeze another's (analysis 06
  §1.2 recommendation), per-tenant LLM cost attribution.
