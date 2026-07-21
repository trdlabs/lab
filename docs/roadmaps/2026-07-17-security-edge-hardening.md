# Security edge hardening — lab-local roadmap entry (2026-07-17)

Canonical cross-repo status lives in the control-center
[initiative registry](../../../control-center/docs/delivery/cross-repo-initiatives.md)
and the
[security-edge-hardening card](../../../control-center/docs/delivery/initiatives/security-edge-hardening.md);
this file keeps only lab's local slice (registry rule: no plan duplication).

Full audit: control-center
[`docs/analysis/08-security-boundary-audit.md`](../../../control-center/docs/analysis/08-security-boundary-audit.md).

## Lab's part — `proposed`

Lab's own bearer auth is already fail-closed (constant-time compare, middleware
before route registration, no identity-passthrough — lab **cannot** be turned
into a platform-admission bypass; paper-intake uses a lab-held service token +
fixed `source:'trading-lab'` + mandatory evidence + a default-OFF kill switch).
Remaining items:

- callback-auth accepts the token in the query string
  (`src/auth/callback-auth.ts:12-13`) → move to a header or a short-lived signed
  URL (avoids token leakage into access logs).
- default `BIND_ADDR=127.0.0.1` in the compose overlays and bind the ingress /
  read listeners to loopback (`src/ingress/server.ts` calls `serve()` with no
  hostname → `0.0.0.0` in-container). Today :3000/:3100 are not host-published,
  but one overlay change would expose the mutating `/tasks` intake.
- the DooD `docker.sock` mount lives in `docker-compose.demo.yml` (demo-only,
  effective host-root) — keep it out of any non-local topology.
- office-server (baked into lab's VPS compose) publishes on `0.0.0.0:8787` by
  default and ships no `OFFICE_OPERATOR_PASSWORD` → wire the password + default
  `BIND_ADDR=127.0.0.1` here (office fail-closes on its side).
  - **Password wiring: done.** Base compose passes `OFFICE_OPERATOR_PASSWORD`
    through to office-server and every env template declares it empty, so a
    connected stack stays down until one is provisioned out of band. Paired with
    the office-side fail-closed guard — the two must ship together.
  - **`BIND_ADDR` default: still open** (initiative item 5), tracked separately.
- `/chat/confirm` authority (initiative item 4): trading-office confirms an
  opaque `pendingInteractionId` and cannot see the class of action behind it, so
  the refusal lives here, next to the real `ActionProposal`
  (`src/chat/confirm-authority.ts`). Fail-closed allowlist of research/backtest
  actions; anything else — including a future execution-capable proposal — is
  refused before `confirmPending`, with a typed 403.
  - Follow-up (SEC-O5): the confirm contract still hands out a bare proposal id.
    A signed, TTL-bound, session-bound capability token would additionally stop a
    substituted id; not required for this item.
