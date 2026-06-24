# Phoenix Observability (tracing slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream Mastra agent LLM-call traces into a self-hosted Arize Phoenix, behind a default-off flag, wired at the single `composeMastra()` seam and shipped in all three docker overlays.

**Architecture:** Add `PHOENIX_*` env parsing → add a pure `phoenixArizeConfig(env)` helper in `src/mastra/compose-mastra.ts` that returns an `@mastra/arize` `ArizeExporter` config (or `undefined`) → spread it into the existing `new Mastra({ agents })` as `observability.configs.arize` → add a `phoenix` docker service + env passthrough + overlay port-publish + `.env.*.example` entries → update README + roadmap. When the flag is off the `observability` key is omitted entirely (zero overhead).

**Tech Stack:** TypeScript (Node `--experimental-strip-types` / `--experimental-transform-types` in docker), Vitest, `@mastra/core` 1.41, `@mastra/arize`, pnpm, Docker Compose, `arizephoenix/phoenix` image.

**Spec:** `docs/superpowers/specs/2026-06-24-phoenix-observability-tracing-design.md`

## Global Constraints

- **Runtime:** code runs via `node --experimental-strip-types` — **no TypeScript parameter properties** (`constructor(private x)`). Use explicit field declarations. The AST guard `src/strip-types-no-param-properties.test.ts` must stay green.
- **Mastra import boundary:** new `Agent` / `Mastra` construction lives only under `src/mastra/`. The `@mastra/arize` import + `ArizeExporter` construction go in `src/mastra/compose-mastra.ts` only. `src/mastra/mastra-import-boundary.guard.test.ts` must stay green.
- **Default OFF:** `PHOENIX_ENABLED` defaults to `false`; off means no `observability` config, no `ArizeExporter` constructed.
- **No network in unit tests:** assert config **shape** only; never start a live Phoenix in Vitest.
- **Privacy:** Phoenix is a self-hosted opt-in debug surface; trace data stays on the host. The strict no-raw-text invariant continues to bind the persisted `agent_event` audit log, not Phoenix.
- **Embeddings / RAG locked values** are unchanged by this slice.
- Full gate after each code task: `pnpm typecheck` and `pnpm test` green.

---

### Task 1: `PHOENIX_*` environment parsing

**Files:**
- Modify: `src/config/env.ts` (the `Env` interface + the `loadEnv` return object)
- Test: `src/config/env.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: three new `Env` fields — `PHOENIX_ENABLED: boolean`, `PHOENIX_COLLECTOR_ENDPOINT: string`, `PHOENIX_PROJECT_NAME: string`. Defaults: `false`, `'http://localhost:6006/v1/traces'`, `'trading-lab'`.

- [ ] **Step 1: Write the failing test**

Add to `src/config/env.test.ts` (after the `reranker env` describe block):

```ts
describe('Phoenix observability env', () => {
  it('defaults Phoenix off with localhost collector + trading-lab project', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.PHOENIX_ENABLED).toBe(false);
    expect(env.PHOENIX_COLLECTOR_ENDPOINT).toBe('http://localhost:6006/v1/traces');
    expect(env.PHOENIX_PROJECT_NAME).toBe('trading-lab');
  });

  it('reads Phoenix overrides from source', () => {
    const env = loadEnv({
      PHOENIX_ENABLED: 'true',
      PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix:6006/v1/traces',
      PHOENIX_PROJECT_NAME: 'trading-lab-vps',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.PHOENIX_ENABLED).toBe(true);
    expect(env.PHOENIX_COLLECTOR_ENDPOINT).toBe('http://phoenix:6006/v1/traces');
    expect(env.PHOENIX_PROJECT_NAME).toBe('trading-lab-vps');
  });

  it('treats any non-"true" PHOENIX_ENABLED as false', () => {
    expect(loadEnv({ PHOENIX_ENABLED: '1' } as unknown as NodeJS.ProcessEnv).PHOENIX_ENABLED).toBe(false);
    expect(loadEnv({ PHOENIX_ENABLED: 'yes' } as unknown as NodeJS.ProcessEnv).PHOENIX_ENABLED).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/config/env.test.ts`
Expected: FAIL — `env.PHOENIX_ENABLED` is `undefined` (property does not exist on `Env`), TypeScript/assertion error.

- [ ] **Step 3: Add the fields to the `Env` interface**

In `src/config/env.ts`, immediately after the line `AGENT_EVENT_STREAM_HEARTBEAT_MS: number;` add:

```ts
  /** Feature flag: export Mastra agent traces to a self-hosted Phoenix (default: false). */
  PHOENIX_ENABLED: boolean;
  /** Phoenix OTLP HTTP collector endpoint (default: http://localhost:6006/v1/traces; docker: http://phoenix:6006/v1/traces). */
  PHOENIX_COLLECTOR_ENDPOINT: string;
  /** Phoenix project name / OTel serviceName (default: trading-lab). */
  PHOENIX_PROJECT_NAME: string;
```

- [ ] **Step 4: Parse the fields in `loadEnv`**

In `src/config/env.ts`, in the object returned by `loadEnv`, immediately before the `...loadRagEnv(source),` line add:

```ts
    PHOENIX_ENABLED: source.PHOENIX_ENABLED === 'true',
    PHOENIX_COLLECTOR_ENDPOINT: source.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006/v1/traces',
    PHOENIX_PROJECT_NAME: source.PHOENIX_PROJECT_NAME ?? 'trading-lab',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- src/config/env.test.ts`
Expected: PASS (all three new cases green).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: clean (no errors).

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(phoenix): parse PHOENIX_* observability env (default off)"
```

---

### Task 2: Wire Phoenix `ArizeExporter` into `composeMastra`

**Files:**
- Modify: `package.json` (add `@mastra/arize` dependency)
- Modify: `src/mastra/compose-mastra.ts` (`MastraCompositionEnv` interface + new `phoenixArizeConfig` helper + the `new Mastra({...})` call)
- Test: `src/mastra/compose-mastra.test.ts`

**Interfaces:**
- Consumes: `MastraCompositionEnv` extended with the three `PHOENIX_*` fields from Task 1 (the real `loadEnv()` `Env` is assignable to it).
- Produces: `export function phoenixArizeConfig(env: MastraCompositionEnv): { serviceName: string; exporters: ArizeExporter[] } | undefined` — returns `undefined` when `PHOENIX_ENABLED` is false, else one `ArizeExporter` configured with the endpoint, under `serviceName = PHOENIX_PROJECT_NAME`. `composeMastra` spreads it into `new Mastra({ agents, observability: { configs: { arize } } })`.

- [ ] **Step 1: Install the `@mastra/arize` dependency**

Run: `pnpm add @mastra/arize`
Expected: `package.json` gains `"@mastra/arize"` under `dependencies`; `pnpm-lock.yaml` updated. (Requires network. On WSL2 behind a slow CDN, `pnpm add @mastra/arize --network-concurrency 1` is a fallback.)

- [ ] **Step 2: Write the failing test**

Add to `src/mastra/compose-mastra.test.ts`. First extend the import line at the top:

```ts
import { composeMastra, phoenixArizeConfig, type MastraCompositionEnv } from './compose-mastra.ts';
import { ArizeExporter } from '@mastra/arize';
```

Then add the three Phoenix fields to the `base` object (so it stays assignable to `MastraCompositionEnv`). The `base` object's closing lines become:

```ts
  BUILDER_ADAPTER: 'fake', BUILDER_MODEL: 'anthropic/claude-sonnet-4-6',
  PHOENIX_ENABLED: false,
  PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces',
  PHOENIX_PROJECT_NAME: 'trading-lab',
};
```

Then add this describe block after the existing `describe('composeMastra', ...)` block:

```ts
describe('phoenixArizeConfig', () => {
  it('returns undefined when PHOENIX_ENABLED is false', () => {
    expect(phoenixArizeConfig(base)).toBeUndefined();
  });

  it('builds one ArizeExporter under the project serviceName when enabled', () => {
    const cfg = phoenixArizeConfig({
      ...base,
      PHOENIX_ENABLED: true,
      PHOENIX_PROJECT_NAME: 'trading-lab',
      PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix:6006/v1/traces',
    });
    expect(cfg).toBeDefined();
    expect(cfg!.serviceName).toBe('trading-lab');
    expect(cfg!.exporters).toHaveLength(1);
    expect(cfg!.exporters[0]).toBeInstanceOf(ArizeExporter);
  });

  it('composeMastra still returns a Mastra instance with Phoenix enabled', () => {
    const rt = composeMastra({ ...base, PHOENIX_ENABLED: true });
    expect(rt.mastra).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- src/mastra/compose-mastra.test.ts`
Expected: FAIL — `phoenixArizeConfig` is not exported (import error), and `base` is missing the `PHOENIX_*` fields until added.

- [ ] **Step 4: Add the import + extend `MastraCompositionEnv`**

In `src/mastra/compose-mastra.ts`, add to the imports at the top (after the existing `@mastra/core` imports):

```ts
import { ArizeExporter } from '@mastra/arize';
```

Then, in the `MastraCompositionEnv` interface, immediately after the line `BUILDER_MODEL: string;` add:

```ts
  PHOENIX_ENABLED: boolean;
  PHOENIX_COLLECTOR_ENDPOINT: string;
  PHOENIX_PROJECT_NAME: string;
```

- [ ] **Step 5: Add the `phoenixArizeConfig` helper**

In `src/mastra/compose-mastra.ts`, add this exported function immediately above `export function composeMastra(`:

```ts
/**
 * Build the Phoenix/Arize observability config for the Mastra runtime.
 * Returns undefined when the flag is off so the `observability` key is omitted
 * entirely (zero overhead, no exporter constructed). Self-hosted Phoenix needs
 * no apiKey — only the OTLP collector endpoint.
 */
export function phoenixArizeConfig(
  env: MastraCompositionEnv,
): { serviceName: string; exporters: ArizeExporter[] } | undefined {
  if (!env.PHOENIX_ENABLED) return undefined;
  return {
    serviceName: env.PHOENIX_PROJECT_NAME,
    exporters: [new ArizeExporter({ endpoint: env.PHOENIX_COLLECTOR_ENDPOINT })],
  };
}
```

- [ ] **Step 6: Spread the config into `new Mastra(...)`**

In `src/mastra/compose-mastra.ts`, replace this line inside `composeMastra`:

```ts
  const mastra = new Mastra({ agents: registry });
```

with:

```ts
  const arize = phoenixArizeConfig(env);
  const mastra = new Mastra({
    agents: registry,
    ...(arize ? { observability: { configs: { arize } } } : {}),
  });
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm test -- src/mastra/compose-mastra.test.ts`
Expected: PASS (all existing cases + the three new `phoenixArizeConfig` cases green).

- [ ] **Step 8: Run the guard + full suite + typecheck**

Run: `pnpm test -- src/mastra/mastra-import-boundary.guard.test.ts src/strip-types-no-param-properties.test.ts`
Expected: PASS (both guards green — the new code lives in `src/mastra/` and uses no parameter properties).

Run: `pnpm typecheck && pnpm test`
Expected: clean typecheck; full suite green.

> If `pnpm typecheck` rejects `observability: { configs: { arize } }` because Mastra's config type is stricter than the structural object, widen the helper's return type to the exporter list and inline the literal at the call site exactly as the `@mastra/arize` README shows (`observability: { configs: { arize: { serviceName, exporters: [...] } } }`) — the shape from the official exporter docs is authoritative. Do not add `as any`.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/mastra/compose-mastra.ts src/mastra/compose-mastra.test.ts
git commit -m "feat(phoenix): wire ArizeExporter into composeMastra observability seam"
```

---

### Task 3: Docker — `phoenix` service, env passthrough, overlay ports, env examples

**Files:**
- Modify: `docker-compose.yml` (add `phoenix` service + volume; add `PHOENIX_*` env to `ingress` and `worker`)
- Modify: `docker-compose.demo.yml` (publish `phoenix` port + restart)
- Modify: `docker-compose.local.yml` (publish `phoenix` port + restart)
- Modify: `docker-compose.vps.yml` (publish `phoenix` port on loopback + restart)
- Modify: `.env.example`, `.env.demo.example`, `.env.local.example`, `.env.vps.example`

**Interfaces:**
- Consumes: the `PHOENIX_*` env contract from Task 1 (`PHOENIX_ENABLED`, `PHOENIX_COLLECTOR_ENDPOINT`, `PHOENIX_PROJECT_NAME`).
- Produces: a running `phoenix` service reachable at `http://phoenix:6006/v1/traces` inside the compose network; UI published on host `6006` (loopback). No code; verified by `docker compose config` parse via `make config-check`.

- [ ] **Step 1: Add the `phoenix` service to the base compose**

In `docker-compose.yml`, add this service after the `redis:` service block (before `ingress:`):

```yaml
  phoenix:
    image: arizephoenix/phoenix:latest
    environment:
      # Persist traces under a mounted dir so they survive restarts (esp. on vps).
      PHOENIX_WORKING_DIR: /mnt/phoenix
    volumes:
      - phoenix_data:/mnt/phoenix
    expose:
      - "6006"
    restart: "no"
    networks: [trading]
```

- [ ] **Step 2: Add the `phoenix_data` volume**

In `docker-compose.yml`, under the top-level `volumes:` key, add `phoenix_data:` alongside `lab_pg:`:

```yaml
volumes:
  lab_pg:
  phoenix_data:
```

- [ ] **Step 3: Pass `PHOENIX_*` to `ingress`**

In `docker-compose.yml`, in the `ingress:` service `environment:` map, immediately after the `OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}` line add:

```yaml
      # Phoenix observability (Mastra agent tracing). Off by default; the demo/local/vps
      # env files flip PHOENIX_ENABLED=true. Endpoint targets the compose `phoenix` service.
      PHOENIX_ENABLED: ${PHOENIX_ENABLED:-false}
      PHOENIX_COLLECTOR_ENDPOINT: ${PHOENIX_COLLECTOR_ENDPOINT:-http://phoenix:6006/v1/traces}
      PHOENIX_PROJECT_NAME: ${PHOENIX_PROJECT_NAME:-trading-lab}
```

- [ ] **Step 4: Pass `PHOENIX_*` to `worker`**

In `docker-compose.yml`, in the `worker:` service `environment:` map, immediately after its `OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}` line add the identical three lines:

```yaml
      PHOENIX_ENABLED: ${PHOENIX_ENABLED:-false}
      PHOENIX_COLLECTOR_ENDPOINT: ${PHOENIX_COLLECTOR_ENDPOINT:-http://phoenix:6006/v1/traces}
      PHOENIX_PROJECT_NAME: ${PHOENIX_PROJECT_NAME:-trading-lab}
```

- [ ] **Step 5: Publish the Phoenix UI port in the demo overlay**

In `docker-compose.demo.yml`, add this service block (the demo binds everything to loopback) after the `backtester:` service block:

```yaml
  # ── phoenix UI (loopback only; open http://localhost:6006) ──
  phoenix:
    ports:
      - "127.0.0.1:${PHOENIX_PORT:-6006}:6006"
    restart: "no"
```

- [ ] **Step 6: Publish the Phoenix UI port in the local overlay**

In `docker-compose.local.yml`, add after the `worker:` block:

```yaml
  phoenix:
    ports:
      - "127.0.0.1:${PHOENIX_PORT:-6006}:6006"
    restart: "no"
```

- [ ] **Step 7: Publish the Phoenix UI port in the vps overlay (loopback — reached via the office reverse proxy)**

In `docker-compose.vps.yml`, add after the `worker:` block (note: **always `127.0.0.1`**, never `${BIND_ADDR}` — the Phoenix UI must not be published to the public internet; it is fronted by the host reverse proxy with auth):

```yaml
  phoenix:
    ports:
      - "127.0.0.1:${PHOENIX_PORT:-6006}:6006"
    restart: unless-stopped
```

- [ ] **Step 8: Enable Phoenix in the docker env examples**

In `.env.demo.example`, `.env.local.example`, and `.env.vps.example`, append:

```bash

# Phoenix observability — Mastra agent tracing to the self-hosted phoenix service.
# UI at http://localhost:6006 (vps: behind the office reverse proxy with auth).
PHOENIX_ENABLED=true
PHOENIX_COLLECTOR_ENDPOINT=http://phoenix:6006/v1/traces
PHOENIX_PROJECT_NAME=trading-lab
```

In `.env.example` (the documentation template that ships defaults-off), append:

```bash

# Phoenix observability (off by default). Set PHOENIX_ENABLED=true and run a Phoenix
# instance to export Mastra agent traces. In docker the endpoint is http://phoenix:6006/v1/traces.
PHOENIX_ENABLED=false
PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006/v1/traces
PHOENIX_PROJECT_NAME=trading-lab
```

- [ ] **Step 9: Validate all three overlays parse**

Run: `make config-check`
Expected output: `demo OK`, `local OK`, `vps OK` (each `docker compose ... config` parses with the matching `.env.*.example`).

- [ ] **Step 10: Commit**

```bash
git add docker-compose.yml docker-compose.demo.yml docker-compose.local.yml docker-compose.vps.yml .env.example .env.demo.example .env.local.example .env.vps.example
git commit -m "feat(phoenix): add phoenix docker service + PHOENIX_* passthrough + overlay ports"
```

- [ ] **Step 11: (Manual, optional — done-criterion #1) Live-verify on the local overlay**

This step needs a Docker daemon and rebuilds the lab image from source (so it includes `@mastra/arize`). It is a manual acceptance check, not a committable gate.

```bash
cp .env.local.example .env.local   # ensure PHOENIX_ENABLED=true + an LLM key + adapters=mastra as needed
make local                          # docker compose ... up --build
```

Then drive one operator chat turn (or any mastra-mode agent call) and open `http://localhost:6006`. Expected: a trace for the agent run appears in the Phoenix UI under project `trading-lab`. Note in the PR description that the demo overlay (GHCR-pulled lab image) only shows traces once the lab image is re-published with `@mastra/arize`.

---

### Task 4: Docs — README + roadmap

**Files:**
- Modify: `README.md` (the `## Observability (Phoenix)` section ~line 579 + the security-checklist row ~line 618)
- Modify: `docs/conversational-operator-roadmap.md` (status table row + the `### Phoenix observability` section)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–3.
- Produces: docs reflecting "tracing slice shipped"; no code.

- [ ] **Step 1: Update the README Observability section**

In `README.md`, replace the `🟡 **Coming soon.**` paragraph and the `> Изначально курс...` blockquote in the `## Observability (Phoenix)` section. Replace this block:

```markdown
🟡 **Coming soon.** Сейчас канонический след решений агента — это **append-only таблица
`agent_event`** в Postgres: каждый значимый шаг (старт/финиш агента, отклонение валидации, сабмит
бэктеста, решение Evaluator) пишется как неизменяемое событие; его отдаёт read-only API на
дашборд.
```

with:

```markdown
🟢 **Трейсинг подключён (срез 1).** Канонический след решений агента — это **append-only таблица
`agent_event`** в Postgres: каждый значимый шаг (старт/финиш агента, отклонение валидации, сабмит
бэктеста, решение Evaluator) пишется как неизменяемое событие; его отдаёт read-only API на
дашборд. Поверх — трейсы Mastra-агентов экспортируются в **self-hosted Phoenix** через
`@mastra/arize` (OTel/OpenInference). Включается флагом `PHOENIX_ENABLED=true`; в docker-стеке
Phoenix поднимается сервисом `phoenix` (UI на `:6006`).
```

And replace this blockquote:

```markdown
> Изначально курс предполагает LangFuse; здесь по согласованию используется Phoenix —
> подключение в процессе.
```

with:

```markdown
> Изначально курс предполагает LangFuse; здесь по согласованию используется Phoenix.
> Срез 1 — трейсинг. Кастомные атрибуты RAG-пайплайна, datasets/experiments и измерение
> latency p95 / cost per run — отдельные срезы (потребляют этот поток трейсов).
```

- [ ] **Step 2: Update the README security-checklist row**

In `README.md`, in the `## Security-чеклист` table, replace this row:

```markdown
| Аудит/трейсинг доступов | 🟡 | `agent_event` есть; Phoenix-трейсинг — в работе |
```

with:

```markdown
| Аудит/трейсинг доступов | ✅ | `agent_event` + Phoenix-трейсинг (self-hosted, флаг `PHOENIX_ENABLED`) |
```

- [ ] **Step 3: Update the roadmap status table**

In `docs/conversational-operator-roadmap.md`, replace this status-table row:

```markdown
| — | Phoenix observability | 🔜 Backlog |
```

with:

```markdown
| — | Phoenix observability | ✅ Tracing slice shipped (Mastra-native `@mastra/arize` → self-hosted Phoenix, all overlays; custom attrs / datasets / metrics = follow-ups) |
```

- [ ] **Step 4: Update the roadmap Phoenix section**

In `docs/conversational-operator-roadmap.md`, replace the `### Phoenix observability` section body:

```markdown
### Phoenix observability
The audit events already emit Phoenix/OpenTelemetry-compatible attributes; wire the
Phoenix TS SDK for tracing/datasets/experiments. Observability only — not a
canonical store. Reference: research §9.
```

with:

```markdown
### Phoenix observability — ✅ TRACING SLICE SHIPPED
Mastra-native AI tracing exported to a **self-hosted Phoenix** via the official `@mastra/arize`
`ArizeExporter`, wired at the single `composeMastra()` seam (`src/mastra/compose-mastra.ts`) behind
`PHOENIX_ENABLED` (default OFF). The `phoenix` docker service runs on all three overlays
(demo/local/vps); on vps the `6006` UI is loopback-only behind the office reverse-proxy with auth.
Observability only — not a canonical store; the strict no-raw-text invariant continues to bind the
persisted `agent_event` log. Spec:
`docs/superpowers/specs/2026-06-24-phoenix-observability-tracing-design.md`; plan:
`docs/superpowers/plans/2026-06-24-phoenix-observability-tracing.md`.

**Follow-ups (separate slices):** custom RAG-pipeline span attributes (research §9), Phoenix
datasets/experiments, measuring + publishing latency p95 / cost per run / success rate, and
surfacing Phoenix traces in the trading-office dashboard via the Phoenix API.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/conversational-operator-roadmap.md
git commit -m "docs(phoenix): mark tracing slice shipped in README + roadmap"
```

---

## Self-Review

**1. Spec coverage:**
- Goal / tracing-only depth → Tasks 1–2 (env + seam), no custom attrs (out-of-scope honored).
- Architecture: single `composeMastra` attachment point, flag-off omits `observability` → Task 2 Steps 5–6.
- Config / env (`PHOENIX_ENABLED` / `PHOENIX_COLLECTOR_ENDPOINT` / `PHOENIX_PROJECT_NAME` + defaults) → Task 1.
- Docker: `phoenix` service across demo/local/vps + passthrough → Task 3 Steps 1–8.
- vps exposure rule (loopback, reverse-proxy, no public publish) → Task 3 Step 7 + env example comment.
- New dependency `@mastra/arize` → Task 2 Step 1.
- Privacy stance → Global Constraints + docs (Task 4); no code change needed.
- Testing (compose shape test, env-parse test, guards green) → Task 1 Step 1, Task 2 Steps 2/8.
- Done criteria #1 live verify → Task 3 Step 11; #2 default-off no-op → Task 2 Step 7 (`base` has flag off) + full suite; #3 all overlays → Task 3 Step 9; #4 roadmap row → Task 4 Step 3.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code/edit step shows the literal content. The one conditional (Task 2 Step 8 typecheck contingency) is a concrete fallback to the documented exporter shape, not a placeholder.

**3. Type consistency:** `phoenixArizeConfig` signature is identical in the Interfaces block (Task 2), the test (Step 2), and the implementation (Step 5): `(env: MastraCompositionEnv) => { serviceName: string; exporters: ArizeExporter[] } | undefined`. The three `PHOENIX_*` field names + types match across `Env` (Task 1 Step 3), `MastraCompositionEnv` (Task 2 Step 4), the `base` test object (Task 2 Step 2), and the docker env keys (Task 3). Endpoint default string `http://localhost:6006/v1/traces` is identical in code (Task 1 Step 4) and test (Task 1 Step 1).
