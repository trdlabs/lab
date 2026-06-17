# 2026-06-18 — Feature 007: events + decisions on BotResultsReadPort

## Goal
Extend `BotResultsReadPort` in `trading-lab` with paginated `getOperationalEvents` and `getDecisionLog`, then update mock/fixture/http adapters and selector coverage without changing orchestration behavior.

## Constraints
- Keep a single read seam: extend `BotResultsReadPort`, do not add a second port.
- Reuse SDK ops-read DTOs / page envelope shapes; no derived replacements.
- `runs/trades/summary` behavior must remain unchanged.
- No backtest/runtime boundary changes.

## Files
- `src/ports/bot-results-read.port.ts`
- `src/adapters/platform/http-ops-read.adapter.ts`
- `src/adapters/platform/mock-bot-results.adapter.ts`
- `src/adapters/platform/fixture-bot-results.adapter.ts`
- `src/adapters/platform/*.test.ts`
- `src/adapters/platform/__fixtures__/bot-results/*` if needed

## Execution
1. Add failing adapter tests for page-returning methods and HTTP cursor propagation.
2. Extend the port with page aliases/types and new methods.
3. Implement new methods in `mock`, `fixture`, and `http` adapters.
4. Add/update fixture data for events/decisions including `by-run` page files.
5. Run targeted tests, then `pnpm typecheck` and the relevant suite.
