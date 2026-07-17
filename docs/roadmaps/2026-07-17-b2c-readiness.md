# B2C readiness — lab-local roadmap entry (2026-07-17)

Canonical cross-repo status lives in the control-center
[initiative registry](../../../control-center/docs/delivery/cross-repo-initiatives.md) —
this file keeps only the lab-local slice (registry rule: no plan duplication).

## Cards and lab's part

- [b2c-f1-tenancy](../../../control-center/docs/delivery/initiatives/b2c-f1-tenancy.md) — `proposed`.
  Lab part: `tenant_id` in all 21 tables (`src/db/schema.ts`) threaded through the
  `TaskIntakeInput` / `QueueEnvelope` chokepoint (`src/orchestrator/task-intake.ts`);
  delivery lease + `LAB_QUEUE_CONCURRENCY > 1` (the missing-lease caveat is documented in
  `src/worker/worker.ts:20-24`); per-tenant LLM cost rollup (extend `make-on-usage.ts`
  correlationId accounting with a tenant dimension — decision 2026-07-17: single provider
  account + per-tenant attribution).
- [b2c-cal](../../../control-center/docs/delivery/initiatives/b2c-cal.md) — `proposed`.
  Lab part: `src/research/proposed-risk-profile.ts` stays a *proposal* (CAL assigns final
  sizing); surface `no_capital_slot` rejections in the paper flow instead of swallowing them.
- [b2c-sdk-consolidation](../../../control-center/docs/delivery/initiatives/b2c-sdk-consolidation.md) — `proposed`.
  **Step 0 lives here:** realign lab off the pinned `@trdlabs/backtester-sdk` v0.7.0 tarball
  to the current version (small PR, before any contract changes); later migrate imports to
  `@trdlabs/sdk/backtester`.
- [b2c-ops-hardening](../../../control-center/docs/delivery/initiatives/b2c-ops-hardening.md) — `proposed`.
  Lab part: worker heartbeat for alerting; replace hardcoded `lab:lab` Postgres creds in
  `docker-compose.yml`.

## Local quick wins (independent of the cards, each < 1 day)

1. BullMQ `priority` for `paper.monitor` (`src/adapters/queue/route-task-type.ts`) —
   live/paper-strategy monitoring must not queue behind multi-minute research cycles in the
   same FIFO lane.
2. `AbortSignal.timeout` wrapper around every `agent.generate` call (14 production call
   sites; the pattern already exists in the operator-RAG reranker,
   `mastra-reranker.adapter.ts`) — today a hung LLM request blocks the single worker slot
   indefinitely.
3. Redis-backed per-session chat rate limiter (`src/chat/chat-rate-limiter.ts` is
   instance-global and in-memory).

Full analysis: control-center
[`docs/analysis/06-b2c-readiness-report.md`](../../../control-center/docs/analysis/06-b2c-readiness-report.md)
§1.2 (tenancy audit), §3.3 (LLM call architecture: no timeouts / retry / cache / priority).
