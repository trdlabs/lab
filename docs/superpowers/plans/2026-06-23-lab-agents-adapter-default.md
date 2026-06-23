# One master switch for the agent adapter family — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `LAB_AGENTS_ADAPTER` (default `fake`) as the family default for all five agent adapters; each per-agent `<AGENT>_ADAPTER` still overrides. "Go fully real" = one env line.

**Architecture:** Resolution lives only in `loadEnv` (`src/config/env.ts`) via a small `resolveAdapter` helper. `docker-compose.yml` forwards the raw knob; env.ts decides. `LAB_AGENTS_ADAPTER` is a pure input — not on the `Env` interface, consumed nowhere downstream.

**Tech Stack:** TypeScript (run via `node --experimental-strip-types`), Vitest, docker compose.

## Global Constraints

- Runtime is `node --experimental-strip-types` — **no TS parameter properties** anywhere node loads (`src/` + `scripts/`).
- Default behaviour MUST stay `fake` when `LAB_AGENTS_ADAPTER` is unset — full backward compatibility; existing `env.chat.test.ts` cases stay green unchanged.
- The five agents: `STRATEGY_ANALYST`, `RESEARCHER`, `CRITIC`, `BUILDER`, `TURN_INTERPRETER`.
- Single source of truth for resolution = `loadEnv`; compose only forwards raw values.
- `LAB_AGENTS_ADAPTER` is NOT added to the `Env` interface.

---

### Task 1: `loadEnv` family-default resolution + tests

**Files:**
- Modify: `src/config/env.ts` (`loadEnv`, ~L101-150)
- Test: `src/config/env.test.ts`

**Interfaces:**
- Consumes: `loadEnv(source: NodeJS.ProcessEnv): Env`
- Produces: unchanged `Env` shape; the five `*_ADAPTER` fields now resolve through the family default.

- [ ] **Step 1: Write the failing tests** — append to `src/config/env.test.ts`:

```ts
describe('loadEnv — agent adapter family default', () => {
  const ADAPTERS = [
    'STRATEGY_ANALYST_ADAPTER',
    'RESEARCHER_ADAPTER',
    'CRITIC_ADAPTER',
    'BUILDER_ADAPTER',
    'TURN_INTERPRETER_ADAPTER',
  ] as const;

  it('defaults every agent adapter to fake when nothing is set', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    for (const k of ADAPTERS) expect(env[k]).toBe('fake');
  });

  it('LAB_AGENTS_ADAPTER=mastra flips all five to mastra', () => {
    const env = loadEnv({ LAB_AGENTS_ADAPTER: 'mastra' } as NodeJS.ProcessEnv);
    for (const k of ADAPTERS) expect(env[k]).toBe('mastra');
  });

  it('a per-agent value overrides the mastra family default', () => {
    const env = loadEnv({ LAB_AGENTS_ADAPTER: 'mastra', BUILDER_ADAPTER: 'fake' } as NodeJS.ProcessEnv);
    expect(env.BUILDER_ADAPTER).toBe('fake');
    expect(env.STRATEGY_ANALYST_ADAPTER).toBe('mastra');
    expect(env.RESEARCHER_ADAPTER).toBe('mastra');
    expect(env.CRITIC_ADAPTER).toBe('mastra');
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('mastra');
  });

  it('a per-agent mastra still works when the family default is fake', () => {
    const env = loadEnv({ STRATEGY_ANALYST_ADAPTER: 'mastra' } as NodeJS.ProcessEnv);
    expect(env.STRATEGY_ANALYST_ADAPTER).toBe('mastra');
    expect(env.RESEARCHER_ADAPTER).toBe('fake');
    expect(env.CRITIC_ADAPTER).toBe('fake');
    expect(env.BUILDER_ADAPTER).toBe('fake');
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('fake');
  });

  it('an invalid LAB_AGENTS_ADAPTER falls back to fake', () => {
    const env = loadEnv({ LAB_AGENTS_ADAPTER: 'bogus' } as NodeJS.ProcessEnv);
    for (const k of ADAPTERS) expect(env[k]).toBe('fake');
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run src/config/env.test.ts`
Expected: the new cases fail (LAB_AGENTS_ADAPTER not honored yet — case 2 and 3 fail).

- [ ] **Step 3: Implement** — in `src/config/env.ts`, inside `loadEnv`, immediately after the `export function loadEnv(...)` line and before `return {`, add:

```ts
  const agentsDefault: 'fake' | 'mastra' = source.LAB_AGENTS_ADAPTER === 'mastra' ? 'mastra' : 'fake';
  const resolveAdapter = (v: string | undefined): 'fake' | 'mastra' =>
    v === 'mastra' ? 'mastra' : v === 'fake' ? 'fake' : agentsDefault;
```

Then replace the five adapter expressions in the returned object:
- `STRATEGY_ANALYST_ADAPTER: source.STRATEGY_ANALYST_ADAPTER === 'mastra' ? 'mastra' : 'fake',` → `STRATEGY_ANALYST_ADAPTER: resolveAdapter(source.STRATEGY_ANALYST_ADAPTER),`
- `RESEARCHER_ADAPTER: source.RESEARCHER_ADAPTER === 'mastra' ? 'mastra' : 'fake',` → `RESEARCHER_ADAPTER: resolveAdapter(source.RESEARCHER_ADAPTER),`
- `CRITIC_ADAPTER: source.CRITIC_ADAPTER === 'mastra' ? 'mastra' : 'fake',` → `CRITIC_ADAPTER: resolveAdapter(source.CRITIC_ADAPTER),`
- `BUILDER_ADAPTER: source.BUILDER_ADAPTER === 'mastra' ? 'mastra' : 'fake',` → `BUILDER_ADAPTER: resolveAdapter(source.BUILDER_ADAPTER),`
- `TURN_INTERPRETER_ADAPTER: source.TURN_INTERPRETER_ADAPTER === 'mastra' ? 'mastra' : 'fake',` → `TURN_INTERPRETER_ADAPTER: resolveAdapter(source.TURN_INTERPRETER_ADAPTER),`

Do NOT add `LAB_AGENTS_ADAPTER` to the `Env` interface.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run src/config/env.test.ts src/config/env.chat.test.ts`
Expected: all pass — the new family-default block AND the existing chat cases (default fake / explicit mastra / `bogus → fake`).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(env): LAB_AGENTS_ADAPTER family default for all agent adapters"
```

---

### Task 2: docker-compose forwarding + docs

**Files:**
- Modify: `docker-compose.yml` (ingress ~L61-70, worker ~L131-140)
- Modify: `.env.example`, `.env.demo.example`, `.env.dev.example`, `README.md`

**Interfaces:**
- Consumes: the env-var resolution from Task 1 (`LAB_AGENTS_ADAPTER` + per-agent overrides).
- Produces: nothing code-facing.

- [ ] **Step 1: Edit `docker-compose.yml`** — in BOTH the `ingress` and `worker` `environment:` blocks:
  - Add one line: `LAB_AGENTS_ADAPTER: ${LAB_AGENTS_ADAPTER:-fake}`
  - Change each of the five per-agent lines from `${X:-fake}` to `${X:-}`:
    - `STRATEGY_ANALYST_ADAPTER: ${STRATEGY_ANALYST_ADAPTER:-}`
    - `RESEARCHER_ADAPTER: ${RESEARCHER_ADAPTER:-}`
    - `CRITIC_ADAPTER: ${CRITIC_ADAPTER:-}`
    - `BUILDER_ADAPTER: ${BUILDER_ADAPTER:-}`
    - `TURN_INTERPRETER_ADAPTER: ${TURN_INTERPRETER_ADAPTER:-}`

- [ ] **Step 2: Validate compose interpolation**

Run: `docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo.example config >/dev/null && echo "demo OK"`
Expected: `demo OK` (no interpolation/parse error). Also run the full `make config` if docker is available.

- [ ] **Step 3: Document the knob** — in `.env.example`, `.env.demo.example`, `.env.dev.example`, add near the per-agent adapter lines a commented block:

```
# Master switch for ALL agent adapters (strategy-analyst, researcher, critic, builder, turn-interpreter).
# Default fake (stubs, key-free). Set =mastra to make every agent use the real LLM at once.
# A per-agent <AGENT>_ADAPTER below still overrides this default.
# LAB_AGENTS_ADAPTER=mastra
```

In `README.md`, add one line next to the existing adapter documentation noting `LAB_AGENTS_ADAPTER` as the one-knob family default (per-agent overrides win).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example .env.demo.example .env.dev.example README.md
git commit -m "feat(compose+docs): forward LAB_AGENTS_ADAPTER + document the one-knob default"
```

---

## Self-Review

- Spec coverage: Task 1 covers change A + testing; Task 2 covers B + C. ✓
- Type consistency: `resolveAdapter` returns `'fake' | 'mastra'` matching the `Env` field types. ✓
- No placeholders: all code shown verbatim. ✓
- Backward compat: family default `fake` ⇒ existing configs/tests unchanged. ✓
