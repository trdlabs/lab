# One master switch for the agent adapter family — Design

**Status:** Approved (brainstorm 2026-06-23; user chose "one master switch" over key-gated / blanket-flip)
**Repo:** trading-lab

## Goal

Make "run all agents for real" a **single** env knob instead of five. Today each of
the five agent adapters defaults to `fake` and must be flipped individually
(`STRATEGY_ANALYST_ADAPTER=mastra`, `RESEARCHER_ADAPTER=mastra`,
`CRITIC_ADAPTER=mastra`, `BUILDER_ADAPTER=mastra`, `TURN_INTERPRETER_ADAPTER=mastra`).
Introduce a family-default knob `LAB_AGENTS_ADAPTER` (default `fake`) that sets the
default for all five; each per-agent `<AGENT>_ADAPTER` still overrides when explicitly
set. "Go fully real" becomes one line: `LAB_AGENTS_ADAPTER=mastra`.

## Why this shape (not the alternatives)

The `fake` default is a deliberate **fail-safe**: key-free demo, offline CI/tests, no
accidental spend. A blanket flip to `mastra`-default would invert that and force `=fake`
into CI/tests/key-free demo (more explicit config than today, plus accidental-cost risk).
A key-gated default ("mastra when a key is present") adds implicit, surprising cost. The
master switch keeps the **family default `fake`** (safe, fully backward-compatible) while
collapsing the five-variable flip into one.

## Changes

### A. `src/config/env.ts` — family default + per-agent override resolution
At the top of `loadEnv`, before the returned object literal, add:
```ts
const agentsDefault: 'fake' | 'mastra' = source.LAB_AGENTS_ADAPTER === 'mastra' ? 'mastra' : 'fake';
const resolveAdapter = (v: string | undefined): 'fake' | 'mastra' =>
  v === 'mastra' ? 'mastra' : v === 'fake' ? 'fake' : agentsDefault;
```
Replace the five `source.X_ADAPTER === 'mastra' ? 'mastra' : 'fake'` expressions with
`resolveAdapter(source.X_ADAPTER)`:
- `STRATEGY_ANALYST_ADAPTER: resolveAdapter(source.STRATEGY_ANALYST_ADAPTER)`
- `RESEARCHER_ADAPTER: resolveAdapter(source.RESEARCHER_ADAPTER)`
- `CRITIC_ADAPTER: resolveAdapter(source.CRITIC_ADAPTER)`
- `BUILDER_ADAPTER: resolveAdapter(source.BUILDER_ADAPTER)`
- `TURN_INTERPRETER_ADAPTER: resolveAdapter(source.TURN_INTERPRETER_ADAPTER)`

`LAB_AGENTS_ADAPTER` is a **pure input knob** — it is NOT added to the `Env` interface and
is consumed nowhere downstream; only the five resolved values flow on. No `MastraCompositionEnv`
/ factory changes.

**Resolution semantics (single source of truth):**
- per-agent explicitly `mastra` → `mastra`; explicitly `fake` → `fake`.
- per-agent unset / empty / any other value → `agentsDefault`.
- `LAB_AGENTS_ADAPTER` unset / not `mastra` → `agentsDefault = fake`.

**Backward compatibility:** with `LAB_AGENTS_ADAPTER` unset, `agentsDefault = fake`, so every
existing config resolves identically (incl. the existing `bogus → fake` case, since
`resolveAdapter('bogus') = agentsDefault = fake`).

### B. `docker-compose.yml` — pass the knob, let env.ts resolve
Both `ingress` and `worker` services. Add one line per service:
```yaml
LAB_AGENTS_ADAPTER: ${LAB_AGENTS_ADAPTER:-fake}
```
Change each of the five per-agent lines from `${X:-fake}` to `${X:-}` (unset → empty →
env.ts applies the family default). Resolution logic lives only in env.ts — compose just
forwards the raw values. Setting `LAB_AGENTS_ADAPTER=mastra` in the env-file flips all five;
a per-agent `X_ADAPTER=…` in the env-file still overrides.

### C. Docs
- `.env.example`, `.env.demo.example`, `.env.dev.example`: document `LAB_AGENTS_ADAPTER`
  (commented, default `fake`; "set `=mastra` to make ALL agents real; per-agent
  `<AGENT>_ADAPTER` overrides"). Keep the existing per-agent examples.
- `README.md`: one line documenting the master switch alongside the per-agent knobs.

## Testing

`src/config/env.test.ts` — new `describe('loadEnv — agent adapter family default')`:
1. `loadEnv({})` → all five adapters `'fake'`.
2. `loadEnv({ LAB_AGENTS_ADAPTER: 'mastra' })` → all five `'mastra'`.
3. `loadEnv({ LAB_AGENTS_ADAPTER: 'mastra', BUILDER_ADAPTER: 'fake' })` → `BUILDER_ADAPTER` `'fake'`, other four `'mastra'`.
4. `loadEnv({ STRATEGY_ANALYST_ADAPTER: 'mastra' })` → `STRATEGY_ANALYST_ADAPTER` `'mastra'`, other four `'fake'`.
5. `loadEnv({ LAB_AGENTS_ADAPTER: 'bogus' })` → all five `'fake'`.

Existing `src/config/env.chat.test.ts` cases (default fake / explicit mastra / bogus→fake)
must stay green unchanged. **Full suite green + typecheck clean** is the gate.

## Invariants / scope

- **Default unchanged = `fake`** — fail-safe preserved; CI/tests/key-free demo unaffected.
- **Demo stays mixed** — the demo runs interpreter-only-real (`TURN_INTERPRETER_ADAPTER=mastra`
  + RAG), analyst/researcher/builder/critic fake; it keeps its per-agent override, NOT the
  master switch (which would turn all five real). Out of scope to change the demo's mode.
- **strip-types** — no TS parameter properties.
- Out of scope: key-gated defaults; changing any agent's model defaults; touching
  `MastraCompositionEnv` / composition warnings (they fire on the resolved value, unchanged).
