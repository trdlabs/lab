# R5c-lab — Cycle Scorecard Markdown (durable contract)

**Status:** spec for the Lab-side slice. Implementation plan: `docs/superpowers/plans/2026-07-15-r5c-cycle-scorecard-markdown.md`.
**Consumers depend on THIS file, not on the plan.** R5d (Office) references the contract below.

## Purpose

Turn a closed-cycle `CycleScorecard` (R5a/R5b, `cycle-scorecard-v1`) into a human-readable Russian Markdown report and expose it Lab-side: a `/v1` read-API markdown surface plus a stable link on the `research.run_cycle` completion summary. Deterministic, LLM-free, no new persistence.

## Scope boundary

- **In (R5c-lab):** pure renderer, `?format=markdown` on the existing scorecard route, `links.scorecardUrl` on the run-cycle summary.
- **Out (R5d, separate PR):** Office consuming the markdown into the conversation — DTO mirror gains `scorecardUrl`, authenticated `text/markdown` fetch, launch moment + bounded retry, chat render. Depends on a retry-lifecycle design. **Sequence: Lab first, Office after.**

## Contract 1 — read-API markdown surface

- **Endpoint:** `GET /v1/cycles/:correlationId/scorecard?format=markdown`
- **200:** body is `text/markdown; charset=utf-8`, the rendered scorecard (see Contract 3). First line begins `## `.
- **Missing row:** unchanged JSON 404 envelope `{ "error": { "code": "not_found", "message": "cycle scorecard not available" } }`, status 404. Markdown is returned only on a 200.
- **Default (no `format`, or any other value):** unchanged JSON payload (`CycleScorecard`), status 200.
- **Auth:** same read-token bearer gate as the rest of `/v1`. No `Accept`-header negotiation in this slice — the query param is the only switch.
- **Path is a single source of truth:** route template `CYCLE_SCORECARD_ROUTE` and mount prefix `READ_API_V1_PREFIX` live in `src/read-api/paths.ts`; the URL builder derives the public URL from the same constants.

## Contract 2 — `scorecardUrl` link on the run-cycle summary

- `RunCycleCompletionSummary.links.scorecardUrl?: string`.
- **Value:** a **relative canonical** path `/v1/cycles/<encodeURIComponent(correlationId)>/scorecard?format=markdown` produced by `cycleScorecardMarkdownUrl(correlationId)` in `src/read-api/paths.ts`.
- **Always present** for a `research.run_cycle` summary (built unconditionally from the task's required `correlationId`). It is **not** gated on the scorecard row existing — the summary is emitted before the async scorecard task writes the row, so an existence check would almost always be null and never self-heal.
- **Therefore the link MAY 404 for a window** after the summary is produced, until the scorecard row lands. Consumers must tolerate this (see R5d obligations).

## Contract 3 — markdown content (stable shape)

Russian headings/labels; identifiers and machine enums (`terminalOutcome.reason`, `RevisionDecision`, `HoldoutValidationReason`, `PreservationReason`, `EvaluationDecision`, `terminalStatus`, unavailable-reasons) rendered **verbatim inside backticks**. Table cells and code spans escape `` ` ``, `|`, and newlines.

Sections, in order:
1. **Header** — one of four terminal titles keyed by `terminalOutcome.kind` (`accepted` ✅ / `rejected` ❌ / `skipped` ⏭️ / `abandoned` ⚠️), plus verbatim reason and profile id.
2. **Отбор гипотез** — `built` / `evaluated`; `eligible` and `considered` rendered **independently** (each either a count or `_недоступно_` with its own unavailable-reason); "выбрано N из {eligible}" when `eligible` is known, else "выбрано N".
3. **Revision block** — `### 🏆 Champion` when `champion` + `revisionAssessment` present; `### Ревизия отклонена` when an assessment exists without a champion; `_Слияние не выполнялось._` when no assessment and `provenance.mergeAttempted === false`. The block renders, when present:
   - **Оценка отбора** — baseline/candidate/Δ table (net PnL, max drawdown, trades), `decision` (`ACCEPT`/`REJECT`), evaluator version, the four `RevisionEvaluatorPolicy` thresholds (explainability — R5a persisted them), and reasons.
   - **Сохранность сделок** — veto fired/not; match/disappeared/new/baseline-winner counts; when fired, reason + available `totalDelta`/`eodDelta`/`dropPct` (optional only when present) + thresholds.
   - **Робастность (holdout)** — `mode:'none'` → "не проверялась" + reason; else mode/boundary/holdout verdict + reason, `holdoutReasons` when present, and a ⚠️ low-confidence marker when `robustness.lowConfidence === true`.
4. **Ростер гипотез** — table of `hypId` / `lastDecision` / `terminalStatus` / considered (✓/—); `_Гипотезы отсутствуют._` when empty.
5. **Footer** — `correlationId` + `schemaVersion`.

Determinism: the renderer is a pure function of the scorecard; roster order is fixed upstream (R5b sorts `cycleHypothesisIds`). No timestamps, randomness, or environment reads.

## R5d (Office) obligations

- Add `scorecardUrl` to Office's `LabSummaryLinks` DTO mirror and have `completionSummaryRender` handle it.
- Fetch with `Accept`/query `?format=markdown` and the Lab read token; render into the conversation.
- **Launch moment + bounded retry:** the link MAY 404 until the scorecard row lands (Contract 2). Retry with a bounded budget; on final failure show "отчёт недоступен" rather than an error.
- **Security invariant:** treat `scorecardUrl` as a relative canonical `/v1/cycles/...` path only and prepend the configured Lab base URL. **Do not follow an arbitrary absolute URL from the DTO** — that would let Office's authenticated read token be sent to an unintended host.

## Non-goals

No LLM, no DB migration, no new env var, no `Accept`-header negotiation, no change to research/selection logic, no Office code in the Lab PR.
