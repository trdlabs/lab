# LLM Strategy Authoring (F2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `MastraStrategyBuilder` — a real-LLM strategy-bundle builder that authors a `createStrategyModule` from a frozen long_oi `StrategyProfile`, drop-in for the F1 pipe.

**Architecture:** Additive strategy LLM-builder alongside the untouched overlay `MastraBuilder`. `MastraStrategyBuilder` mirrors `MastraBuilder`: `agent.generate(userMsg, { structuredOutput: { schema } })` → re-`.parse(result.object)` → adapter → `StrategyBuilderOutput` (F1 port). L1-retry (schema-parse) is build()-owned, bounded. Hermetic tests use the existing `fakeAgent` seam; the real LLM proof is F2b (separate).

**Tech Stack:** TypeScript, vitest, zod, Mastra (`agent.generate` structured output), `@trading-backtester/sdk` (getAuthoringDoc/createModuleManifest), `@trading-platform/sdk`.

## Global Constraints

- **Additive only:** the overlay path (`MastraBuilder`, `builder.agent`, `BuilderOutputSchema`, `hypothesisBuildHandler`) is NOT modified. The F1 `StrategyBuilder` port is enriched ADDITIVELY (new optional fields; `FakeStrategyBuilder` must still compile + pass its F1 tests).
- **OpenAI-strict LLM schema:** the strategy LLM-output zod schema MUST use arrays-not-records and nullable-not-optional (mirror `LlmBuilderOutputSchema` in `src/adapters/builder/mastra-builder.ts`), so OpenAI strict-mode JSON Schema accepts it. A separate `llmToStrategyBuilderOutput` adapter maps LLM-shape → domain `StrategyBuilderOutput`.
- **Strict schema, no trusted-field smuggling:** the LLM schema is `.strict()` and carries NO `bundleHash`/`bytes` — the hash is computed only in F1 `assembleStrategyBundle` (Variant-2).
- **L1-retry build()-owned:** Mastra has NO native retry and `AgentCallOpts` has only `onUsage`. Implement a single bounded retry loop (N attempts) around generate+parse in `build()`; on exhaustion `throw BuilderError`. No double-retry.
- **Mastra call shape (verbatim mirror of `MastraBuilder.build`):** `await agent.generate(prompt, { structuredOutput: { schema: <zod> }, modelSettings: { maxOutputTokens } })`, then `schema.parse(result.object)`.
- **Source kind:** the long_oi description fixture is submitted as `StrategyAnalystInput { kind: 'manual_description', content }` (NOT 'strategy_text').
- **F2a scope:** the builder + schemas + frozen profile + agent-factory, hermetically tested. F2b (049-endpoint + iterate loop + real-LLM proof + compose-mastra production wiring) is OUT (separate). `pnpm check` EXIT 0.

## File Structure

```
src/ports/strategy-builder.port.ts                    # MODIFY (F1): enrich Input (profile?, feedback?), port (adapter/model, opts?), BuildFeedback
src/domain/strategy-llm-output.ts                     # NEW: StrategyManifestSchema (hand-written zod, kind:'strategy', OpenAI-strict) + StrategyLlmOutputSchema + llmToStrategyBuilderOutput
src/adapters/builder/strategy-user-message.ts         # NEW: buildStrategyUserMessage(profile, feedback?)
src/mastra/agents/strategy-builder.agent.ts           # NEW: createStrategyBuilderAgent (INSTRUCTIONS + STRATEGY_AUTHORING_DOC verbatim)
src/adapters/builder/mastra-strategy-builder.ts       # NEW: MastraStrategyBuilder (generate + L1-retry + parse + adapter)
src/adapters/builder/fixtures/long-oi-profile.json    # NEW committed: frozen StrategyProfile
scripts/regen-long-oi-profile.mts                      # NEW: real analyst once → long-oi-profile.json (gated)
```

---

### Task 1: Enrich the F1 StrategyBuilder port (additive) + BuildFeedback

**Files:**
- Modify: `src/ports/strategy-builder.port.ts`
- Test: `src/adapters/builder/fake-strategy-builder.test.ts` (F1 — must stay green)

**Interfaces:**
- Produces: `StrategyBuilderInput { spec; authoringDoc; profile?: StrategyProfile; feedback?: BuildFeedback }`; `StrategyBuilder { adapter: string; model: string; build(i, opts?: AgentCallOpts): Promise<StrategyBuilderOutput> }`; `type BuildFeedback = { kind:'validation'; violations: string[] } | { kind:'parity'; diff: { bar:number; field:string; expected:unknown; actual:unknown } }`.

- [ ] **Step 1: Write/extend the failing test** — assert `FakeStrategyBuilder` still satisfies the enriched `StrategyBuilder` (build returns the fixed shortAfterPump output; `adapter`/`model` present, e.g. `'fake'`/`'fake'`); a `StrategyBuilderInput` with `profile`/`feedback` type-checks; `FakeStrategyBuilder.build` ignores them.
- [ ] **Step 2: Run, verify it fails** (the new fields/props don't exist yet).
- [ ] **Step 3: Implement** — add `profile?: StrategyProfile` (import from `src/domain/strategy-profile.ts`), `feedback?: BuildFeedback` to `StrategyBuilderInput`; add `BuildFeedback` union; add `adapter`/`model` + optional `opts?: AgentCallOpts` to the port; add `readonly adapter='fake'; readonly model='fake';` to `FakeStrategyBuilder`. All additive — F1 behavior unchanged.
- [ ] **Step 4: Run, verify it passes** (incl. existing F1 fake-builder + handler tests).
- [ ] **Step 5: Commit** — `feat(llm-authoring): enrich StrategyBuilder port (profile/feedback/adapter/model/opts) — additive`

---

### Task 2: StrategyManifestSchema + StrategyLlmOutputSchema + adapter

**Files:**
- Create: `src/domain/strategy-llm-output.ts`
- Test: `src/domain/strategy-llm-output.test.ts`

**Interfaces:**
- Consumes: `CreateModuleManifestInput` shape (mirror `@trading-backtester/sdk` `builder/manifest.ts`); F1 `StrategyManifestMeta`/`StrategyBuilderOutput` (`src/ports/strategy-builder.port.ts`).
- Produces: `StrategyManifestSchema` (zod, OpenAI-strict, `kind` literal `'strategy'`), `StrategyLlmOutputSchema` (`.strict()`, `{ manifest, source, notes }`), `type StrategyLlmOutput`, `llmToStrategyBuilderOutput(o): StrategyBuilderOutput`.

- [ ] **Step 1: Write the failing test** — (a) a valid LLM object → `StrategyLlmOutputSchema.parse` ok → `llmToStrategyBuilderOutput` → `{ source, manifestMeta }` where `manifestMeta` has no `kind`; (b) object with a smuggled `bundleHash` → `.strict()` parse THROWS; (c) `manifest.kind` ≠ `'strategy'` → parse throws; (d) OpenAI-strict shape: any array fields are `z.array`, any optional-ish fields are `.nullable()` not `.optional()` (assert the schema rejects an object missing a nullable field unless it's explicitly null — mirror `LlmBuilderOutputSchema`).
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement** — hand-write `StrategyManifestSchema` mirroring `CreateModuleManifestInput` (`id, version, kind:z.literal('strategy'), name, summary, rationale, hooks:z.array(z.enum([...])), paramsSchema, capabilities, dataNeeds`, optional fields as `.nullable()`), pin `kind`. `StrategyLlmOutputSchema = z.object({ manifest: StrategyManifestSchema, source: z.string().min(1), notes: z.string().nullable() }).strict()`. `llmToStrategyBuilderOutput` = `{ source: o.source, manifestMeta: omit(o.manifest,'kind') }` (cast/shape to `StrategyManifestMeta`).
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(llm-authoring): strict strategy-LLM-output schema + manifest zod + adapter`

---

### Task 3: createStrategyBuilderAgent + buildStrategyUserMessage

**Files:**
- Create: `src/mastra/agents/strategy-builder.agent.ts`, `src/adapters/builder/strategy-user-message.ts`
- Test: `src/adapters/builder/strategy-user-message.test.ts`

**Interfaces:**
- Consumes: `getAuthoringDoc` (`@trading-backtester/sdk/builder`), `AnalystProfileOutput`/`StrategyProfile` (`src/domain/strategy-profile.ts`), `BuildFeedback` (Task 1).
- Produces: `createStrategyBuilderAgent(deps: { model; authoringDoc: string }): Agent` (mirror `createBuilderAgent` in `src/mastra/agents/builder.agent.ts` — `INSTRUCTIONS` + `SDK reference:\n${authoringDoc}` verbatim); `buildStrategyUserMessage(profile: AnalystProfileOutput, feedback?: BuildFeedback): string`.

- [ ] **Step 1: Write the failing test** — `buildStrategyUserMessage(profile)` returns a string containing the profile's `coreIdea`, `direction`, `entryConditions`/`exitConditions`, and a clear TASK instruction ("author createStrategyModule … return {manifest, source}"). With `feedback={kind:'validation',violations:['x']}` → contains the violations; with `{kind:'parity',diff:{bar:5,field:'pnl',…}}` → contains the bar/field diff. (Mechanism only — no LLM.)
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement** — `STRATEGY_INSTRUCTIONS` (role + rules: emit self-contained ESM `export default createStrategyModule`, no imports, hooks onBarClose/onPositionBar, no `bundleHash`) + embed `authoringDoc` verbatim (it's already `##`-sectioned markdown). `buildStrategyUserMessage` serializes the `AnalystProfileOutput` into a structured prompt section + the task + (if feedback) a typed feedback section.
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(llm-authoring): strategy builder agent (authoring-doc system block) + user-message assembler`

---

### Task 4: MastraStrategyBuilder (generate + L1-retry + parse + adapter)

**Files:**
- Create: `src/adapters/builder/mastra-strategy-builder.ts`
- Test: `src/adapters/builder/mastra-strategy-builder.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 + the `fakeAgent` seam (mirror `src/adapters/builder/mastra-builder.usage.test.ts:42` — `{ generate: async () => ({ object, usage }) } as unknown as Agent`).
- Produces: `class MastraStrategyBuilder implements StrategyBuilder` (`constructor(agent: Agent, label: string, opts?: { maxAttempts?: number })`).

- [ ] **Step 1: Write the failing tests** (fakeAgent + frozen-ish profile inline): (a) **happy** — agent returns a valid `object` → `build()` → valid `StrategyBuilderOutput`; assert the agent was called with `{ structuredOutput: { schema } }`. (b) **L1 exhaustion** — call-counting agent ALWAYS returns an invalid `object` (fails `StrategyLlmOutputSchema.parse`) → `build()` retries exactly `maxAttempts` (e.g. 3) → throws `BuilderError`; assert call count === maxAttempts. (c) **L1 recovery** — agent invalid for (maxAttempts-1) then valid → `build()` succeeds. (d) **strict reject** — agent returns object with smuggled `bundleHash` → eventually `BuilderError` (strict parse never passes). (e) **feedback** — `build({…, feedback})` → assert the user-message passed to `agent.generate` contains the feedback.
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement** — `build(input, opts)`: `userMsg = buildStrategyUserMessage(input.profile.profile ?? input.profile, input.feedback)`; loop up to `maxAttempts`: `const result = await this.agent.generate(userMsg, { structuredOutput: { schema: StrategyLlmOutputSchema }, modelSettings: { maxOutputTokens } })`; `try { return llmToStrategyBuilderOutput(StrategyLlmOutputSchema.parse(result.object)) } catch { continue }` (call `opts?.onUsage` per attempt); after loop → `throw new BuilderError('schema-parse exhausted after N')`. `adapter='mastra'; model=<model>`.
- [ ] **Step 4: Run, verify they pass.**
- [ ] **Step 5: Commit** — `feat(llm-authoring): MastraStrategyBuilder (structured-output + bounded L1-retry) + full mechanism tests`

---

### Task 5: Frozen long_oi profile (regen script + fixture + guard)

**Files:**
- Create: `scripts/regen-long-oi-profile.mts`, `src/adapters/builder/fixtures/long-oi-profile.json`
- Test: `src/adapters/builder/fixtures/long-oi-profile.test.ts`

**Interfaces:**
- Consumes: `MastraStrategyAnalyst` (`src/adapters/analyst/mastra-strategy-analyst.ts`), the fixture `docs/fixtures/strategies/long-oi-strategy-source.md`, `StrategyProfileSchema`/`AnalystProfileOutputSchema` (`src/domain/strategy-profile.ts`).

- [ ] **Step 1: Write the failing guard test** — read the committed `long-oi-profile.json` → assert it parses as a valid `StrategyProfile` (or at least `.profile` as `AnalystProfileOutputSchema`), `direction === 'long'`.
- [ ] **Step 2: Run, verify it fails** (fixture missing).
- [ ] **Step 3: Implement** — `regen-long-oi-profile.mts`: construct the REAL `MastraStrategyAnalyst` (via the same path `strategyOnboardHandler` uses; gated on a real LLM env), `analyze({ kind:'manual_description', content: <long-oi-strategy-source.md> })` ONCE → wrap into a `StrategyProfile` (mirror `strategyOnboardHandler` persistence shape) → write `long-oi-profile.json`. Run it once, commit the produced fixture.
- [ ] **Step 4: Run, verify the guard passes** against the committed fixture. `pnpm check` does NOT run the regen script (it's a gated `.mts`).
- [ ] **Step 5: Commit** — `feat(llm-authoring): frozen long_oi profile fixture (real analyst once) + regen script + guard`

---

### Task 6: Wire into `pnpm check` + final regress

- [ ] **Step 1:** Confirm all hermetic `*.test.ts` (Tasks 1-5 guard) run under `pnpm check`; the regen `.mts` is excluded.
- [ ] **Step 2: Run** `pnpm check` → EXIT 0 (no overlay-lane regression; F1 tests green).
- [ ] **Step 3: Commit** — `chore(llm-authoring): wire strategy LLM-builder hermetic tests into pnpm check`

---

## Self-Review

- **Spec coverage:** Architecture(§1)→Tasks 3-4; Components(§2)→Tasks 1-4; Data-flow(§3)→Tasks 3-4; Error-handling(§4: L1 taxonomy + typed feedback)→Tasks 1,4 (L1 exhaustion/recovery tested); Testing(§5: frozen-profile guard + mock-mechanism)→Tasks 4-5. L2/L3 + real-LLM proof are F2b (out of scope, correctly absent).
- **Placeholder scan:** regen script needs a real-LLM env (gated, documented); `StrategyManifestSchema` hand-written per grounding (not a placeholder — explicit). `maxOutputTokens` value confirm-at-impl against `MastraBuilder` (`MAX_OUTPUT_TOKENS`).
- **Type consistency:** `StrategyBuilderInput`/`StrategyBuilder`/`BuildFeedback`/`StrategyLlmOutput`/`llmToStrategyBuilderOutput` names consistent across Tasks 1-4; `kind:'manual_description'` (Task 5) per grounding; OpenAI-strict shapes (Task 2) per `LlmBuilderOutputSchema`.

## Deltas from design (post-grounding)

- LLM schema uses OpenAI-strict shapes (arrays-not-records, nullable-not-optional) + `llmToStrategyBuilderOutput` adapter (mirror `LlmBuilderOutputSchema`/`llmOutputToDomain`).
- `agent.generate(prompt, { structuredOutput: { schema }, modelSettings:{maxOutputTokens} })` + re-`.parse(result.object)` (verbatim `MastraBuilder` mirror); DI-seam = constructor `Agent`; reuse existing `fakeAgent`.
- L1-retry build()-owned bounded loop (Mastra has no native retry).
- `kind: 'manual_description'` (not 'strategy_text').
- `STRATEGY_AUTHORING_DOC` injected verbatim into system-instructions (already `##`-sectioned).
- `StrategyManifestSchema` hand-written (no reusable SDK/lab zod; lab's `ModuleManifestSchema` is overlay-shaped).
- compose-mastra production wiring of the strategy agent → deferred to F2b (F2a hermetic tests use `fakeAgent`).
