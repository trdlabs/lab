# Remove IntentClassifier + TurnInterpreter own-env Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the dead `IntentClassifier` component and give the live `TurnInterpreter` its own env (`TURN_INTERPRETER_ADAPTER` / `_MODEL` / `_MIN_CONFIDENCE`), defaulting to `gemini-3.1-flash-lite` in docker.

**Architecture:** Atomic rename of the borrowed `INTENT_CLASSIFIER_*` env to `TURN_INTERPRETER_*` across the composition + all eval factories + tests (Task 1), then delete the now-unreferenced IntentClassifier files (Task 2), then docker/docs (Task 3).

**Tech Stack:** TypeScript, `node --experimental-strip-types`, Vitest, Mastra, docker-compose.

## Global Constraints

- Runtime `node --experimental-strip-types` — **no TS parameter properties** anywhere under `src/`.
- The TurnInterpreter is gated on `TURN_INTERPRETER_ADAPTER === 'mastra'`; model = `env.TURN_INTERPRETER_MODEL`; confidence gate = `env.TURN_INTERPRETER_MIN_CONFIDENCE`.
- `TURN_INTERPRETER_MODEL` default = `openrouter/google/gemini-3.1-flash-lite`; `TURN_INTERPRETER_MIN_CONFIDENCE` default = `0.6`.
- **Deletion is clean** (verified): the IntentClassifier and TurnInterpreter are parallel mirror copies with no shared code. The only coupling is the three env names + the dormant `intentClassifier` build in `composeMastra`.
- **Full suite + typecheck must be green** at the end of each task — the rename leaves zero dangling references; the deleted files have zero importers.

---

### Task 1: Atomic env rename + decouple + drop the dormant intent agent

**Files (modify):**
- `src/config/env.ts` (the `Env` interface ~L39-41 + `loadEnv` ~L148-150) + `src/config/env.chat.test.ts`
- `src/mastra/compose-mastra.ts` + `src/mastra/compose-mastra.test.ts`
- `src/composition.ts` (`buildTurnInterpreter` warning; `composeRuntime` minConfidence ~L259; `buildOperatorRag` reranker model ~L141)
- `src/experiments/builder/real-builder-factory.ts`, `src/experiments/researcher/real-researcher-factory.ts`, `src/experiments/strategy-analyst/real-analyst-factory.ts` (their `MastraCompositionEnv` `'fake'` stub literals)
- `src/experiments/turn-interpreter/real-turn-interpreter-factory.ts` (`buildRealInterpreterFor` override + throw string)
- `src/adapters/intent/mastra-turn-interpreter.test.ts:108`
- `scripts/turn-interpreter-eval.ts` (`incumbentModelId`)
- `src/mastra/agents/agents.test.ts` (remove the `createIntentClassifierAgent` rows — see Task 2 note; keep the file)

**Interfaces:**
- Produces: `MastraCompositionEnv.{TURN_INTERPRETER_ADAPTER, TURN_INTERPRETER_MODEL}`; `Env.{TURN_INTERPRETER_ADAPTER, TURN_INTERPRETER_MODEL, TURN_INTERPRETER_MIN_CONFIDENCE}`. Removes `MastraRuntime.agents.intentClassifier`.

- [ ] **Step 1: Write/Update the failing tests**

In `src/mastra/compose-mastra.test.ts`: the existing tests reference `INTENT_CLASSIFIER_ADAPTER`/`INTENT_CLASSIFIER_MODEL` and `rt.agents.intentClassifier` (~L11,23). Rewrite them to the new env and assert the decoupling + the dropped entry:
```ts
it('builds the turn interpreter from TURN_INTERPRETER_MODEL when adapter=mastra', () => {
  const env = { ...BASE_MASTRA_ENV, TURN_INTERPRETER_ADAPTER: 'mastra',
    TURN_INTERPRETER_MODEL: 'openrouter/google/gemini-3.1-flash-lite' } as const;
  const rt = composeMastra(env);
  expect(rt.agents.turnInterpreter?.label).toContain('gemini-3.1-flash-lite');
  expect('intentClassifier' in rt.agents).toBe(false); // the dormant agent is gone
});
it('skips the turn interpreter when TURN_INTERPRETER_ADAPTER is fake', () => {
  const env = { ...BASE_MASTRA_ENV, TURN_INTERPRETER_ADAPTER: 'fake' } as const;
  expect(composeMastra(env).agents.turnInterpreter).toBeUndefined();
});
```
(Adapt `BASE_MASTRA_ENV` to the fixture name the file uses; remove its `INTENT_CLASSIFIER_*` keys, add `TURN_INTERPRETER_*`. Match the existing label-substring style.)
In `src/config/env.chat.test.ts` (~L7-28): rename the three asserted keys to `TURN_INTERPRETER_*` and update the expected model default to `openrouter/google/gemini-3.1-flash-lite`.

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run src/mastra/compose-mastra.test.ts src/config/env.chat.test.ts`
Expected: FAIL / TypeScript errors (the new env fields don't exist yet).

- [ ] **Step 3: Rename in `config/env.ts`**

Replace the three `INTENT_CLASSIFIER_*` fields on `Env` and their `loadEnv` parses with `TURN_INTERPRETER_*`:
- `TURN_INTERPRETER_ADAPTER` — same `'mastra'|'fake'` parse.
- `TURN_INTERPRETER_MODEL` — same string parse, **default `'openrouter/google/gemini-3.1-flash-lite'`**.
- `TURN_INTERPRETER_MIN_CONFIDENCE` — same `parseFloatOr(..., 0.6)`.
(Mirror the exact helper calls the file already uses for these three.)

- [ ] **Step 4: Rewire `compose-mastra.ts`**

1. Remove the import `createIntentClassifierAgent, INTENT_CLASSIFIER_AGENT_ID`.
2. In `MastraCompositionEnv`: rename `INTENT_CLASSIFIER_ADAPTER`→`TURN_INTERPRETER_ADAPTER`, `INTENT_CLASSIFIER_MODEL`→`TURN_INTERPRETER_MODEL`.
3. In `MastraRuntime.agents`: remove `intentClassifier?: MastraAgentEntry;`.
4. **Delete** the line `if (env.INTENT_CLASSIFIER_ADAPTER === 'mastra') build(INTENT_CLASSIFIER_AGENT_ID, env.INTENT_CLASSIFIER_MODEL, createIntentClassifierAgent);`.
5. Change the turn-interpreter build to:
```ts
  if (env.TURN_INTERPRETER_ADAPTER === 'mastra')
    build(TURN_INTERPRETER_AGENT_ID, env.TURN_INTERPRETER_MODEL, createTurnInterpreterAgent);
```
6. Remove `intentClassifier: entry(INTENT_CLASSIFIER_AGENT_ID),` from the returned `agents` object.

- [ ] **Step 5: Rewire `composition.ts` + the eval factories + remaining readers**

- `composition.ts`: `buildTurnInterpreter` warning string → `TURN_INTERPRETER_ADAPTER`; `composeRuntime` `minConfidence: env.TURN_INTERPRETER_MIN_CONFIDENCE`; `buildOperatorRag` reranker `resolveLanguageModel(env, env.TURN_INTERPRETER_MODEL)`.
- `src/experiments/{builder,researcher,strategy-analyst}/real-*-factory.ts`: in the `MastraCompositionEnv` literal each builds, rename the `INTENT_CLASSIFIER_ADAPTER: 'fake'` (and any `INTENT_CLASSIFIER_MODEL`) stub to `TURN_INTERPRETER_ADAPTER: 'fake'` (+ `TURN_INTERPRETER_MODEL: ''` if a model field is required by the type).
- `src/experiments/turn-interpreter/real-turn-interpreter-factory.ts`: `INTENT_CLASSIFIER_ADAPTER:'mastra'`→`TURN_INTERPRETER_ADAPTER:'mastra'`, `INTENT_CLASSIFIER_MODEL:modelId`→`TURN_INTERPRETER_MODEL:modelId`; the throw string → `TURN_INTERPRETER_ADAPTER`. (It may also set the other agents' adapters to `'fake'` — rename those keys too.)
- `src/adapters/intent/mastra-turn-interpreter.test.ts:108`: `env.INTENT_CLASSIFIER_MODEL`→`env.TURN_INTERPRETER_MODEL`.
- `scripts/turn-interpreter-eval.ts`: `incumbentModelId: process.env.INTENT_CLASSIFIER_MODEL`→`process.env.TURN_INTERPRETER_MODEL`.
- `src/mastra/agents/agents.test.ts`: remove the `createIntentClassifierAgent` import + its assertion rows (keep the rest).

- [ ] **Step 6: Run — verify pass + full typecheck**

Run: `npx vitest run src/mastra/compose-mastra.test.ts src/config/env.chat.test.ts && npm run typecheck`
Expected: target tests PASS; **typecheck clean** (this proves every `MastraCompositionEnv` consumer was updated — the structural-typing trap). If typecheck flags a missed `INTENT_CLASSIFIER_*` reference, fix it and re-run. Note: the IntentClassifier files still exist (Task 2 deletes them) and may still reference the old names internally — that is fine; they are unreferenced by the rewired code and `tsc` only fails on the project graph it builds. If `tsc` includes those files and they break, leave them for Task 2 and run `npm run typecheck` again after Task 2; OR comment the imports — prefer deleting in Task 2. Confirm the FULL suite once Task 2 lands.

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts src/config/env.chat.test.ts src/mastra/compose-mastra.ts src/mastra/compose-mastra.test.ts src/composition.ts src/experiments/builder/real-builder-factory.ts src/experiments/researcher/real-researcher-factory.ts src/experiments/strategy-analyst/real-analyst-factory.ts src/experiments/turn-interpreter/real-turn-interpreter-factory.ts src/adapters/intent/mastra-turn-interpreter.test.ts scripts/turn-interpreter-eval.ts src/mastra/agents/agents.test.ts
git commit -m "refactor(operator): TURN_INTERPRETER_* env — decouple interpreter + drop dormant intent agent"
```

---

### Task 2: Delete the IntentClassifier component

**Files (delete unless noted):**
- `src/mastra/agents/intent-classifier.agent.ts`, `src/mastra/agents/intent-classifier-judge.agent.ts` (+ any `*.test.ts` siblings)
- `src/adapters/intent/mastra-intent-classifier.ts` + `.test.ts`, `src/adapters/intent/fake-intent-classifier.ts` + `.test.ts`
- `src/ports/intent-classifier.port.ts`
- `src/chat/intent.ts` + `src/chat/intent.test.ts`, `src/chat/intent-provider-schema.ts` (+ test), `src/chat/normalize-intent-output.ts`
- `src/experiments/intent-classifier/` (whole directory, incl. `__fixtures__/chat-intents-v1.json`)
- `scripts/intent-classifier-eval.ts`
- Modify: `package.json` — remove the `"intent:eval"` script line

- [ ] **Step 1: Delete the files + the npm script**

```bash
git rm -r src/experiments/intent-classifier scripts/intent-classifier-eval.ts \
  src/mastra/agents/intent-classifier.agent.ts src/mastra/agents/intent-classifier-judge.agent.ts \
  src/adapters/intent/mastra-intent-classifier.ts src/adapters/intent/mastra-intent-classifier.test.ts \
  src/adapters/intent/fake-intent-classifier.ts src/adapters/intent/fake-intent-classifier.test.ts \
  src/ports/intent-classifier.port.ts \
  src/chat/intent.ts src/chat/intent.test.ts src/chat/intent-provider-schema.ts src/chat/normalize-intent-output.ts
```
(First `ls` each path to confirm it exists; if `intent-classifier.agent.test.ts` / `intent-provider-schema.test.ts` exist, `git rm` them too. Do NOT touch any `*-turn-interpreter.*` file in `src/adapters/intent/`.) Then remove `"intent:eval": "...",` from `package.json`.

- [ ] **Step 2: Verify nothing dangles — full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: **full suite green, typecheck clean** — zero references to any deleted module remain (Task 1 already rewired the live + factory code). If `tsc` reports a missing import, that file was a reference Task 1 missed — fix it (rename/remove the import) and re-run.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(operator): delete the legacy IntentClassifier component (agents, adapters, port, schemas, eval)"
```

---

### Task 3: Docker default + docs

**Files:** `docker-compose.yml`, `.env.example` (+ siblings), `README.md`, `docs/conversational-operator-roadmap.md`

- [ ] **Step 1: docker-compose env rename (both services)**

In `docker-compose.yml`, in BOTH the `ingress` and `worker` `environment:` maps, replace the three `INTENT_CLASSIFIER_*` lines with:
```yaml
      TURN_INTERPRETER_ADAPTER: ${TURN_INTERPRETER_ADAPTER:-fake}
      TURN_INTERPRETER_MODEL: ${TURN_INTERPRETER_MODEL:-openrouter/google/gemini-3.1-flash-lite}
      TURN_INTERPRETER_MIN_CONFIDENCE: ${TURN_INTERPRETER_MIN_CONFIDENCE:-0.6}
```
(Match the existing default for the adapter — if the old `INTENT_CLASSIFIER_ADAPTER` default was `fake`, keep `fake`; the demo overlay / `.env.demo` sets `mastra` + the real key.)

- [ ] **Step 2: .env + README**

In `.env.example` (and any `.env*.example` listing the old vars — grep `INTENT_CLASSIFIER_`), rename to `TURN_INTERPRETER_*` with the new model default + a one-line note. In `README.md` (the `*_MIN_CONFIDENCE` row ~L124, and any `INTENT_CLASSIFIER_*` mention), rename + note the operator interpreter model.

- [ ] **Step 3: Roadmap**

In `docs/conversational-operator-roadmap.md`, add/refresh a line: TurnInterpreter eval shipped (#69) + dataset/prompt fixes (#71) → operator interpreter set to `gemini-3.1-flash-lite` via `TURN_INTERPRETER_MODEL`; the legacy IntentClassifier (superseded by the TurnInterpreter, not on the live path) removed.

- [ ] **Step 4: Verify compose renders + commit**

Run: `docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo.example config >/dev/null && echo "compose OK"` (or the example env the `make config` target uses).
Expected: `compose OK`.
```bash
git add docker-compose.yml .env.example README.md docs/conversational-operator-roadmap.md
git commit -m "chore(operator): docker default TURN_INTERPRETER_MODEL=gemini-3.1-flash-lite + docs"
```

---

## Self-review notes
- **Spec coverage:** Task 1 → spec §A/§B/§C (rename + decouple + drop dormant agent + factory stubs + min_confidence + reranker); Task 2 → §D (delete the component); Task 3 → §E (docker/docs/roadmap).
- **Type consistency:** the single rename `INTENT_CLASSIFIER_{ADAPTER,MODEL,MIN_CONFIDENCE}` → `TURN_INTERPRETER_{…}` is applied identically across `Env`, `MastraCompositionEnv`, all factories, composition, scripts, tests, docker. `typecheck` is the consistency proof.
- **Deletion safety:** Task 1 removes all live/factory references BEFORE Task 2 deletes the files; Task 2's full-suite+typecheck is the dangling-reference gate.

## Definition of Done
Full suite green + typecheck clean after Task 2; turn-interpreter eval dry-run still prints its plan; docker compose renders; the operator interpreter defaults to `gemini-3.1-flash-lite`; the IntentClassifier component is gone; roadmap updated.
