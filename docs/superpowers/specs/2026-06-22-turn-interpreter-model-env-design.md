# Remove the legacy IntentClassifier + give the TurnInterpreter its own env — Design

**Status:** Approved (brainstorm 2026-06-22; scope expanded to full removal 2026-06-23)
**Repo:** trading-lab
**Supersedes:** the earlier "add `TURN_INTERPRETER_MODEL`, keep sharing the adapter" version of this doc — the user chose the full legacy cleanup instead.

## Goal

The conversational operator makes exactly **one** LLM call per chat turn — the `TurnInterpreter` (`chat-handler.ts:handleChatMessage` → `interpreter.interpret`). The older `IntentClassifier` was superseded by the TurnInterpreter (operator Slice 2) and is **not on any live path**: `composition.ts` builds only the TurnInterpreter; `new MastraIntentClassifier` exists only in the intent-classifier eval + unit tests. Yet the TurnInterpreter still *borrows* the IntentClassifier's env (`INTENT_CLASSIFIER_ADAPTER`/`_MODEL`/`_MIN_CONFIDENCE`), and `composeMastra` still constructs a dormant, never-consumed `intentClassifier` agent.

This slice (a) **deletes the entire IntentClassifier component** (agents, adapters, port, chat-intent schemas, eval harness + dataset + script), and (b) **gives the TurnInterpreter its own env** — `TURN_INTERPRETER_ADAPTER` / `TURN_INTERPRETER_MODEL` / `TURN_INTERPRETER_MIN_CONFIDENCE`, with the docker default `TURN_INTERPRETER_MODEL=openrouter/google/gemini-3.1-flash-lite` (the eval winner). One live operator LLM, one correctly-named knob.

## Why now / evidence

The TurnInterpreter eval (#69, #71) chose `gemini-3.1-flash-lite` as the best operator interpreter. Realizing that switch surfaced that the operator's model knob is misnamed (`INTENT_CLASSIFIER_*`) and that the IntentClassifier is dead weight. Deletion confirmed **clean** by a full find_usages sweep: the two components are parallel mirror copies with **no shared code** — the TurnInterpreter has its own `turn-provider-schema.ts` / `normalize-turn-output.ts` / port / adapters; nothing in the TurnInterpreter / composition / ingress / chat path imports any IntentClassifier module.

## Changes

### A. New env (rename the borrowed knobs)
`src/config/env.ts`:
- Replace the three `INTENT_CLASSIFIER_*` fields/parsers with `TURN_INTERPRETER_*`:
  - `TURN_INTERPRETER_ADAPTER: 'mastra' | 'fake'` (same parsing as before).
  - `TURN_INTERPRETER_MODEL: string` — **default `openrouter/google/gemini-3.1-flash-lite`** (was `anthropic/claude-haiku-4-5-20251001`).
  - `TURN_INTERPRETER_MIN_CONFIDENCE: number` — default `0.6` (unchanged value; it gates `turn.confidence` in `guard.ts:planChatAction`, which is the **interpreter's** confidence — the rename makes the name truthful).
- Update `src/config/env.chat.test.ts` to the new names + the new model default.

### B. Composition resolves the interpreter from its own env + drop the dormant agent
`src/mastra/compose-mastra.ts`:
- `MastraCompositionEnv`: rename `INTENT_CLASSIFIER_ADAPTER`/`INTENT_CLASSIFIER_MODEL` → `TURN_INTERPRETER_ADAPTER`/`TURN_INTERPRETER_MODEL`.
- Remove the `createIntentClassifierAgent`/`INTENT_CLASSIFIER_AGENT_ID` import, the `intentClassifier?` field on `MastraRuntime.agents`, the **`build(INTENT_CLASSIFIER_AGENT_ID, …)` line**, and the `intentClassifier: entry(…)` line.
- Re-gate the turn-interpreter build on the new env:
  ```ts
  if (env.TURN_INTERPRETER_ADAPTER === 'mastra')
    build(TURN_INTERPRETER_AGENT_ID, env.TURN_INTERPRETER_MODEL, createTurnInterpreterAgent);
  ```
- Update `src/mastra/compose-mastra.test.ts` (drop `intentClassifier` assertions; the turn-interpreter resolves from `TURN_INTERPRETER_MODEL`).

`src/composition.ts`:
- `buildTurnInterpreter`: change the warning string `'[composition] INTENT_CLASSIFIER_ADAPTER is not "mastra"…'` → `TURN_INTERPRETER_ADAPTER`.
- `composeRuntime`: `minConfidence: env.INTENT_CLASSIFIER_MIN_CONFIDENCE` → `env.TURN_INTERPRETER_MIN_CONFIDENCE`.
- `buildOperatorRag` (the reranker scorer at ~L141): it resolves its model from `env.INTENT_CLASSIFIER_MODEL` — it explicitly "reuses the operator interpreter model for the relevance scorer", so switch it to `env.TURN_INTERPRETER_MODEL` (follows the interpreter).

### C. The other eval factories' `MastraCompositionEnv` stubs (the typecheck trap)
Renaming the `MastraCompositionEnv` fields breaks every factory that constructs that env. The non-intent eval factories hard-set `INTENT_CLASSIFIER_ADAPTER: 'fake'` to satisfy the shape: `src/experiments/{builder,researcher,strategy-analyst}/real-*-factory.ts`. Switch each to `TURN_INTERPRETER_ADAPTER: 'fake'` (drop the `_MODEL` stub if present, or set an empty/placeholder consistent with the others). `src/experiments/turn-interpreter/real-turn-interpreter-factory.ts` switches from setting `INTENT_CLASSIFIER_ADAPTER:'mastra'`+`INTENT_CLASSIFIER_MODEL:modelId` to `TURN_INTERPRETER_ADAPTER:'mastra'`+`TURN_INTERPRETER_MODEL:modelId` (and the throw string at ~L48). `src/adapters/intent/mastra-turn-interpreter.test.ts:108` reads `env.INTENT_CLASSIFIER_MODEL` → `TURN_INTERPRETER_MODEL`. `scripts/turn-interpreter-eval.ts` `incumbentModelId: process.env.INTENT_CLASSIFIER_MODEL` → `TURN_INTERPRETER_MODEL`.

### D. Delete the IntentClassifier component
Delete (verified zero external importers after A–C):
- `src/mastra/agents/intent-classifier.agent.ts`, `src/mastra/agents/intent-classifier-judge.agent.ts` (+ its test if standalone).
- `src/adapters/intent/mastra-intent-classifier.ts` + `.test.ts`, `src/adapters/intent/fake-intent-classifier.ts` + `.test.ts` (delete the 4 files individually — the directory also holds the surviving `*-turn-interpreter.*`).
- `src/ports/intent-classifier.port.ts`.
- `src/chat/intent.ts` (+ `.test.ts`), `src/chat/intent-provider-schema.ts` (+ test), `src/chat/normalize-intent-output.ts`.
- `src/experiments/intent-classifier/**` (whole dir incl. `__fixtures__/chat-intents-v1.json`), `scripts/intent-classifier-eval.ts`, and the `"intent:eval"` script in `package.json`.
- **Update, do NOT delete** `src/mastra/agents/agents.test.ts` — remove only the `createIntentClassifierAgent` rows; it tests surviving agents too.

### E. Docker + docs
- `docker-compose.yml` (both `ingress` and `worker` services, ~L70-72 and ~L140-142): replace the three `INTENT_CLASSIFIER_*` env lines with `TURN_INTERPRETER_*`; set `TURN_INTERPRETER_MODEL: ${TURN_INTERPRETER_MODEL:-openrouter/google/gemini-3.1-flash-lite}`, `TURN_INTERPRETER_ADAPTER: ${TURN_INTERPRETER_ADAPTER:-fake}` (or the existing intent default), `TURN_INTERPRETER_MIN_CONFIDENCE` carrying the old default.
- `.env*.example` + `README.md:124` (the `*_MIN_CONFIDENCE` row): rename + document. The demo `.env.demo` (gitignored, real keys) is the user's to update.
- `docs/conversational-operator-roadmap.md`: record the eval outcome (operator interpreter = `gemini-3.1-flash-lite`) + the IntentClassifier removal (one live operator LLM).

## Testing

- `src/config/env.chat.test.ts`, `src/mastra/compose-mastra.test.ts`, `src/adapters/intent/mastra-turn-interpreter.test.ts`, `src/mastra/agents/agents.test.ts` — updated to the new env names; composition test asserts the turn-interpreter resolves from `TURN_INTERPRETER_MODEL` and there is no `intentClassifier` runtime entry.
- **Full suite green + typecheck clean** is the load-bearing gate — the rename must leave zero dangling references and the deleted files must have zero importers. The turn-interpreter eval `--run` path stays intact (dry-run smoke prints the plan).
- No new test infrastructure.

## Invariants / scope

- **Operator behavior unchanged except the model** — still one `interpret()` call, same guard/trust-boundary; only the model (flash-lite in docker) and the env names change.
- **The TurnInterpreter component is untouched in logic** — its agent/adapters/port/schemas/eval all stay.
- **strip-types** — no TS parameter properties in changed code.
- Out of scope: any TurnInterpreter prompt change (done in #71); reviving the IntentClassifier elsewhere; a paid `--run` re-confirmation (optional follow-up).

## Risk note

This deletes a merged, shipped eval harness (intent-classifier eval, #?) — the user explicitly chose full deletion over retire-from-live. The deletion is reversible from git history if the intent eval is ever wanted again.
