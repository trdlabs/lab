# Phoenix Observability — Slice 1 (tracing only) — Design

**Date:** 2026-06-24
**Status:** Approved (design); ready for implementation plan
**Roadmap:** `docs/conversational-operator-roadmap.md` → "Phoenix observability" (was 🔜 Backlog)
**Research basis:** `docs/research/2026-06-18-operator-rag-architecture-research.md` §9

## Goal

Wire [Arize Phoenix](https://phoenix.arize.com) (OpenTelemetry-compatible LLM
observability) into the existing Mastra runtime so agent LLM calls are traced and
visible in a self-hosted Phoenix UI. **Tracing only** — Phoenix is an observability /
debug surface, **not** a canonical business-data store and not a runtime policy engine.

This unblocks the README's 🟡 items "latency p95 / cost per run / success rate" — those
metrics are *consumed* from traces in a later step; this slice delivers the trace stream.

## Scope decisions (settled with user, 2026-06-24)

1. **Depth:** tracing only. Custom RAG span attributes (research §9), Phoenix
   datasets/experiments, and metric measurement are explicitly out of scope (separate slices).
2. **Deployment:** self-hosted Phoenix as a docker service across all three overlays
   (demo / local / vps). No Phoenix Cloud, no external account. On vps it is reached through
   the existing office reverse-proxy with auth (see § Docker → vps exposure rule).
3. **Instrumentation:** Mastra-native AI tracing via the official `@mastra/arize`
   exporter — a framework primitive (research §6), not a hand-rolled OpenTelemetry NodeSDK.

## Architecture

### Single attachment point: `composeMastra()`

`src/mastra/compose-mastra.ts` already builds the one `new Mastra({ agents })` for the
whole process. That is the only observability attachment point (research §2: "A central
Mastra runtime exists as the future observability attachment point"). Mastra's native AI
tracing auto-instruments every registered agent (turn-interpreter, researcher, critic,
builder, analyst) — no manual spans.

```ts
import { ArizeExporter } from '@mastra/arize';

const mastra = new Mastra({
  agents: registry,
  ...(phoenix.enabled
    ? {
        observability: {
          configs: {
            arize: {
              serviceName: phoenix.serviceName, // e.g. 'trading-lab'
              exporters: [new ArizeExporter({ endpoint: phoenix.endpoint })],
            },
          },
        },
      }
    : {}),
});
```

When the flag is off, the `observability` key is omitted entirely — zero overhead, no
exporter constructed, no OTel batch processor. Mirrors the existing
`DisabledOperatorRetrieval` "off means truly nothing happens" pattern.

`ArizeExporter` (from `@mastra/arize`) maps Mastra spans to OpenInference semantic
conventions and ships them via OTLP to Phoenix. For a local self-hosted collector no
`apiKey` is needed; `endpoint` is the only required field.

### Configuration / env

Add a `PHOENIX_*` block to `src/config/env.ts`, following the `OPERATOR_*` convention
(default-off feature flag + endpoint + name):

| Var | Default | Meaning |
|-----|---------|---------|
| `PHOENIX_ENABLED` | `false` | Master switch. Off → no `observability` config, no exporter. |
| `PHOENIX_COLLECTOR_ENDPOINT` | `http://localhost:6006/v1/traces` | Phoenix OTLP HTTP collector. In docker: `http://phoenix:6006/v1/traces`. |
| `PHOENIX_PROJECT_NAME` | `trading-lab` | Phoenix project / OTel `serviceName`. |

The parsed Phoenix config is threaded into `MastraCompositionEnv` (or a small sibling
field) and read **only** when `PHOENIX_ENABLED` is true.

### Docker

Add a `phoenix` service (`arizephoenix/phoenix` image) to the docker-compose stack, enabled
across **all three overlays — demo, local, and vps**:
- UI + OTLP HTTP collector on `6006`;
- ingress + worker get `PHOENIX_ENABLED=true` and `PHOENIX_COLLECTOR_ENDPOINT=http://phoenix:6006/v1/traces`.

Phoenix is wanted on vps too: the latency p95 / cost per run / success rate metrics
(README 🟡 items) are only meaningful on a real running deployment — the demo can't even
execute real backtests on WSL2 — so production is exactly where the trace stream earns its
keep.

**vps exposure rule (security):** the Phoenix UI captures prompts/completions and must
**not** be published to the internet unauthenticated. vps reuses the **same host-level
reverse proxy that already fronts trading-office** (`docs/docker-vps.md`: `BIND_ADDR=127.0.0.1`
+ "Put a reverse proxy in front that serves the web UI and routes `/api/office/*` + the
WebSocket upgrade"). Phoenix is routed through that proxy on its own subdomain/path (e.g.
`https://phoenix.example.com`) **with auth** (HTTP basic-auth or the same OAuth as office).
The compose `phoenix` service binds `6006` to `127.0.0.1` (loopback always — never `${BIND_ADDR}`) — no
direct `0.0.0.0` publish on vps. Trace data stays on the vps host. The demo/local overlays
may publish `6006` to the host for convenience. `PHOENIX_ENABLED` remains a flag so any
overlay can turn it off.

> The reverse proxy is host-level (operator-provisioned nginx/caddy), not a compose service —
> consistent with how office is already fronted. This slice does not add a proxy container;
> it documents the Phoenix route + auth as a vps deploy step.

### New dependency

`@mastra/arize` (pulls OpenTelemetry transitive deps). The `node --experimental-strip-types`
runtime is unaffected — dependency code lives in `node_modules`, not our strip-types-loaded
`src/`. The "Mastra Agent construction only under `src/mastra/`" import-boundary invariant
holds: the only edit is inside `compose-mastra.ts`.

## Privacy stance

The roadmap privacy invariant — *"audit events carry IDs/hashes/counts/codes/timings —
never raw strategy text, retrieved bodies, embeddings, or secrets"* — governs the
**persisted `agent_event` audit log** (canonical, potentially exported) and any custom
span attributes a future slice adds.

Phoenix is a **separate, self-hosted, opt-in debug surface** (default OFF). Trace data stays
on the host running the stack (the local machine, or the vps host) and is never sent to any
third party; on vps the UI is reachable only through the authenticated office reverse-proxy.
Mastra's native AI tracing captures LLM IO (prompts/completions) by default — that is the
point of LLM observability (debugging, latency, cost). Capturing it into a self-hosted
Phoenix is acceptable and **does not** weaken the invariant, which continues to bind the
canonical audit log. Approved by user 2026-06-24.

Not in scope here (possible later hardening): IO redaction/sampling, attribute scrubbing.

## Testing (TDD)

- `compose-mastra.test.ts`:
  - `PHOENIX_ENABLED=false` → the `Mastra` config has no `observability` key.
  - `PHOENIX_ENABLED=true` → `observability.configs.arize` present with exactly one
    exporter and the configured `serviceName` + `endpoint`. Assert config **shape**, no
    network calls (no live Phoenix needed in CI).
- env-parse test: `PHOENIX_*` defaults resolve as specified.
- `mastra-import-boundary.guard.test.ts` stays green (new `Agent` construction unchanged).
- `strip-types-no-param-properties.test.ts` stays green (no param-property constructors added).

## Out of scope (future slices)

- Custom RAG-pipeline span attributes (research §9: candidate counts, RRF/reranker top-K,
  source IDs + freshness, per-stage latency, fallback reason, correlation IDs).
- Phoenix datasets / experiments (wiring `operator-rag:eval` / analyst-eval into Phoenix).
- Measuring + publishing latency p95 / cost per run / success rate (consumes the traces).
- Phoenix Cloud / hosted deployment.
- Token/cost kill-switch enforcement (roadmap tech debt — uses Phoenix usage *numbers*, but
  enforcement is ours; separate work).
- **Surfacing Phoenix traces in the trading-office dashboard via the Phoenix API** (planned
  follow-up): once the trace stream exists, office can read selected trace/latency/cost data
  through Phoenix's API and render it in the dashboard. Out of scope for this slice — it
  needs its own design (which Phoenix API surface, auth, which metrics, office-side UI), and
  lives partly in the trading-office repo.

## Done criteria

1. `PHOENIX_ENABLED=true` + a running self-hosted Phoenix → agent runs appear as traces in
   the Phoenix UI (verified live on the demo stack).
2. `PHOENIX_ENABLED=false` (default) → no exporter, no OTel processor, no behavior change;
   full test suite green.
3. All three docker overlays (demo / local / vps) bring up Phoenix and ingress/worker
   export to it; on vps the `6006` port is not published to the public internet.
4. Roadmap "Phoenix observability" row moves Backlog → Shipped (tracing slice) with the
   custom-attributes / datasets / metrics work explicitly noted as follow-ups.
