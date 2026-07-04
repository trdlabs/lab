# Slice 079 — Signed Backtest Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a signed backtest-evidence artifact to paper-intake submissions so the platform's 079 verifier admits (not quarantines) them — via a `SignedEvidenceProviderPort` seam, a byte-identical vendored canonicalizer + Ed25519 verify, a fail-fast lab-side pre-flight, CAS delivery, and an additive `evidenceArtifactRef` — plus a backtester handoff doc for the load-bearing producer/fetch gap.

**Spec:** `docs/superpowers/specs/2026-07-04-signed-evidence-079-design.md` (APPROVED; 4 review fixes + §4b rename).

**Architecture:** Lab cannot self-sign (trust boundary): the real signed evidence must come from the backtester (Deliverable A = handoff doc). Lab builds the consumer behind `SignedEvidenceProviderPort` (env axis `none`/`fixture`/`http`, boot-guarded). `paperStartHandler` obtains evidence for the champion's variant run, runs a pure pre-flight verify (Ed25519 + hash-pin + scope + verdict) that mirrors the platform matrix, and only on success delivers the evidence JSON to the CAS and appends its content-hash ref to the submission's `artifactRefs`. A `LAB_PAPER_EVIDENCE_REQUIRED` flag makes 079-enforced intakes fail-closed.

**Tech Stack:** TypeScript (strip-types), node:crypto (Ed25519), Vitest. No new migration (verify-only pre-flight + additive request field).

## Global Constraints

- **Trust boundary:** lab NEVER signs evidence. The only signer is the backtester (`bt-ed25519-*` key). Lab only VERIFIES.
- **Canonicalizer byte-identity:** `canonicalizeEvidenceBody` MUST be byte-identical to the backtester's (`apps/backtester/src/evidence/canonical.ts`): recursive sorted-key stringify, primitives via `JSON.stringify`, arrays order-PRESERVED (not sorted), NO trailing newline, NO number quantization. Header comment cites the source + a version tag.
- **Ed25519 scheme (verify):** `crypto.verify(null, Buffer.from(canonicalizeEvidenceBody(body),'utf8'), createPublicKey(pemSPKI), Buffer.from(signature,'base64'))`; body INCLUDES `keyId`; PEM looked up by `body.keyId` in a `TrustedSigners` (keyId→SPKI-PEM) map.
- **Symbols alignment:** the signed `body.symbols` is SORTED (backtester `buildEvidenceBody` does `[...symbols].sort()`); lab's `scope.symbols` is UNSORTED — scope-match MUST sort both sides before comparing. `body.window.{fromMs,toMs}` === `Date.parse(scope.period.from/to)`.
- **Three acceptance invariants (each an explicit test):** (I1) `LAB_PAPER_EVIDENCE_REQUIRED=true` NEVER submits without evidence; (I2) `source=fixture` impossible in production without explicit override; (I3) `paper.start` appends the evidence artifact ref ONLY after local verify passes, never merely after `provide()`.
- **Additive only:** `paper-intake.port.ts` (#127) extended with an OPTIONAL `evidenceArtifactRef` — the no-evidence path stays byte-identical. NO TS parameter properties.
- Gates per task: focused vitest; before each task-completing commit `npm run typecheck` clean + FULL `npm test` 0 failed (baseline on this branch: 3143 passed).

---

### Task 1: Vendored canonicalizer + Ed25519 verify (pure crypto)

**Files:**
- Create: `src/research/evidence-canonical.ts`, `src/research/evidence-signature.ts`
- Test: `src/research/evidence-signature.test.ts`

**Interfaces (Produces):**

```ts
// evidence-canonical.ts — byte-identical to backtester apps/backtester/src/evidence/canonical.ts
// SOURCE: trading-backtester/apps/backtester/src/evidence/canonical.ts (itself a mirror of
// trading-platform evidence-verifier.ts::canonicalizeEvidenceBody). VERSION: v1 (2026-07-04).
export function canonicalizeEvidenceBody(value: unknown): string;

// evidence-signature.ts
export type TrustedSigners = Readonly<Record<string, string>>; // keyId -> SPKI PEM
export function verifyEvidenceSignature(
  artifact: { body: unknown; signature: string },
  trustedSigners: TrustedSigners,
): boolean; // false on: unknown keyId, bad signature, any crypto throw
```

- [ ] **Step 1: Failing tests** (generate a real Ed25519 keypair in-test, derive keyId, sign, verify):

```ts
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';
import { canonicalizeEvidenceBody } from './evidence-canonical.ts';
import { verifyEvidenceSignature, type TrustedSigners } from './evidence-signature.ts';

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const keyId = 'bt-ed25519-' + createHash('sha256').update(der).digest('hex').slice(0, 16);
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const signBody = (body: unknown): string =>
    cryptoSign(null, Buffer.from(canonicalizeEvidenceBody(body), 'utf8'), privateKey).toString('base64');
  return { keyId, pem, signBody };
}

describe('canonicalizeEvidenceBody', () => {
  it('sorts object keys, preserves array order, no trailing newline', () => {
    expect(canonicalizeEvidenceBody({ b: 1, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"b":1}');
  });
});

describe('verifyEvidenceSignature', () => {
  it('accepts a genuine signature over the canonical body', () => {
    const s = makeSigner();
    const body = { schema: 'backtest-evidence/v1', keyId: s.keyId, verdict: 'passed', symbols: ['A', 'B'] };
    const artifact = { body, signature: s.signBody(body) };
    expect(verifyEvidenceSignature(artifact, { [s.keyId]: s.pem })).toBe(true);
  });
  it('rejects a tampered body (single byte changed)', () => {
    const s = makeSigner();
    const body = { schema: 'backtest-evidence/v1', keyId: s.keyId, verdict: 'passed' };
    const artifact = { body: { ...body, verdict: 'failed' }, signature: s.signBody(body) };
    expect(verifyEvidenceSignature(artifact, { [s.keyId]: s.pem })).toBe(false);
  });
  it('rejects an unknown keyId (empty/missing trusted signer)', () => {
    const s = makeSigner();
    const body = { keyId: s.keyId };
    expect(verifyEvidenceSignature({ body, signature: s.signBody(body) }, {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/research/evidence-signature.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement** — `evidence-canonical.ts` verbatim from the backtester algorithm:

```ts
export function canonicalizeEvidenceBody(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeEvidenceBody).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeEvidenceBody(obj[k])}`).join(',')}}`;
}
```

`evidence-signature.ts`:

```ts
import { verify as cryptoVerify, createPublicKey } from 'node:crypto';
import { canonicalizeEvidenceBody } from './evidence-canonical.ts';
export type TrustedSigners = Readonly<Record<string, string>>;
export function verifyEvidenceSignature(artifact: { body: unknown; signature: string }, trustedSigners: TrustedSigners): boolean {
  const keyId = (artifact.body as { keyId?: string } | null)?.keyId;
  const pem = keyId ? trustedSigners[keyId] : undefined;
  if (!pem) return false;
  try {
    return cryptoVerify(null, Buffer.from(canonicalizeEvidenceBody(artifact.body), 'utf8'), createPublicKey(pem), Buffer.from(artifact.signature, 'base64'));
  } catch { return false; }
}
```

- [ ] **Step 4:** Focused PASS → typecheck → FULL suite. **Step 5: Commit** `feat(research): vendored evidence canonicalizer + Ed25519 verify (byte-identical to backtester)`

---

### Task 2: `SignedEvidenceProviderPort` + `selectSignedEvidence` (env axis + fixture boot-guard) [I2]

**Files:**
- Create: `src/ports/signed-evidence-provider.port.ts`, `src/adapters/platform/select-signed-evidence.ts`
- Test: `src/adapters/platform/select-signed-evidence.test.ts`

**Interfaces:**
- Consumes: `SignedBacktestEvidence` from `src/ports/backtester-strategy.port.ts:5` (reuse the existing type).
- Produces:

```ts
// signed-evidence-provider.port.ts
export interface SignedEvidenceProvideArgs {
  backtesterRunId: string; bundleHash: string; datasetRef: string;
  window: { from: string; to: string }; symbols: string[]; timeframe: string;
}
export interface SignedEvidenceProviderPort {
  readonly available: boolean;
  provide(args: SignedEvidenceProvideArgs): Promise<SignedBacktestEvidence | null>;
}
// select-signed-evidence.ts
export type SignedEvidenceSource = 'none' | 'fixture' | 'http';
export function parseSignedEvidenceSource(raw: string | undefined): SignedEvidenceSource; // throw on unknown
export function selectSignedEvidence(source: NodeJS.ProcessEnv): SignedEvidenceProviderPort;
```

Behaviors (mirror `select-bot-results.ts`): `none`→`{available:false, provide: async()=>null}`. `fixture`→a `FixtureSignedEvidenceProvider` (Task 3 provides the fixture artifact builder; here return a provider that yields a fixture-signed evidence matching the args' scope/hash — **but gated**: `selectSignedEvidence` throws unless `source.NODE_ENV==='test' || source.LAB_ALLOW_FIXTURE_EVIDENCE==='true'` [I2]). `http`→a thin `HttpSignedEvidenceProvider` stub with a header comment `// TODO(079-followup): wire to backtester GET /v1/runs/:id/evidence once Deliverable A ships` whose `provide` returns `null` (available:true, not-yet-fetchable) — do NOT implement HTTP fetching in this slice.

- [ ] **Step 1: Failing tests**:

```ts
it('parseSignedEvidenceSource throws on unknown', () => {
  expect(() => parseSignedEvidenceSource('bogus')).toThrow(/none\|fixture\|http/);
  expect(parseSignedEvidenceSource(undefined)).toBe('none');
});
it('fixture source is refused in production (no override)', () => {
  expect(() => selectSignedEvidence({ LAB_SIGNED_EVIDENCE_SOURCE: 'fixture' })).toThrow(/fixture.*NODE_ENV|LAB_ALLOW_FIXTURE_EVIDENCE/);
});
it('fixture source allowed under NODE_ENV=test', () => {
  expect(selectSignedEvidence({ LAB_SIGNED_EVIDENCE_SOURCE: 'fixture', NODE_ENV: 'test' }).available).toBe(true);
});
it('fixture source allowed under explicit override', () => {
  expect(selectSignedEvidence({ LAB_SIGNED_EVIDENCE_SOURCE: 'fixture', LAB_ALLOW_FIXTURE_EVIDENCE: 'true' }).available).toBe(true);
});
it('none source → available false, provide null', async () => {
  const p = selectSignedEvidence({});
  expect(p.available).toBe(false);
  expect(await p.provide(argsFixture())).toBeNull();
});
```

- [ ] **Step 2: RED** → **Step 3: Implement** (fixture provider builds a signed evidence via Task 3's `buildFixtureSignedEvidence` — if Task 3 not yet present, inline a minimal in-test signer here and refactor in Task 3; prefer implementing Task 3's builder first if executing in order). **Step 4:** gates. **Step 5: Commit** `feat(research): SignedEvidenceProviderPort + selectSignedEvidence env axis with fixture prod-guard`

---

### Task 3: Pre-flight verify `verifySignedEvidence` (pure) + fixture builder

**Files:**
- Create: `src/research/verify-signed-evidence.ts`, `src/research/fixture-signed-evidence.ts` (test-support signer)
- Test: `src/research/verify-signed-evidence.test.ts`

**Interfaces:**
- Consumes: Task 1 `verifyEvidenceSignature`/`TrustedSigners`, `SignedBacktestEvidence`.
- Produces:

```ts
export interface EvidenceCheckScope { bundleHash: string; datasetRef: string; window: { fromMs: number; toMs: number }; symbols: string[]; timeframe: string; }
export type EvidenceVerifyResult = { ok: true } | { ok: false; reason: 'evidence_signature_invalid' | 'backtest_not_passed' | 'bundle_hash_mismatch' | 'scope_mismatch' };
export function verifySignedEvidence(evidence: SignedBacktestEvidence, expected: EvidenceCheckScope, trustedSigners: TrustedSigners): EvidenceVerifyResult;
// fixture-signed-evidence.ts (test/demo only — generates a keypair, returns { evidence, trustedSigners })
export function buildFixtureSignedEvidence(scope: { backtesterRunId: string } & EvidenceCheckScope, verdict?: 'passed' | 'failed'): { evidence: SignedBacktestEvidence; trustedSigners: TrustedSigners };
```

Ladder (mirror platform matrix): signature first (`verifyEvidenceSignature` false → `evidence_signature_invalid`) → `body.verdict!=='passed'` → `backtest_not_passed` → `body.bundleHash!==expected.bundleHash` → `bundle_hash_mismatch` → scope: `body.datasetRef/timeframe` !== expected, OR `body.window.{fromMs,toMs}` !== expected, OR `[...body.symbols].sort()` deep-neq `[...expected.symbols].sort()` → `scope_mismatch` → else `{ok:true}`.

- [ ] **Step 1: Failing tests** — happy (fixture passed+matching scope → ok); each reject branch: tampered signature; `verdict:'failed'`; bundleHash mismatch; datasetRef mismatch; timeframe mismatch; window mismatch; symbols mismatch (and: symbols in DIFFERENT ORDER but same set → still ok, proving sort-compare). Use `buildFixtureSignedEvidence` for the base and mutate.
- [ ] **Step 2: RED** → **Step 3: Implement** the ladder + the fixture builder (keypair via `generateKeyPairSync('ed25519')`, keyId via `deriveKeyId`, sign via `cryptoSign(null, canonical, priv).toString('base64')`, symbols sorted per backtester). **Step 4:** gates. **Step 5: Commit** `feat(research): verifySignedEvidence pre-flight ladder (signature/verdict/hash-pin/scope) + fixture signer`

---

### Task 4: TrustedSigners config + `LAB_PAPER_EVIDENCE_REQUIRED` + boot wiring [I1 boot-half, I2 boot-half]

**Files:**
- Modify: `src/config/env.ts` (`LAB_SIGNED_EVIDENCE_SOURCE` passthrough is read by selector directly; add `LAB_PAPER_EVIDENCE_REQUIRED: source.LAB_PAPER_EVIDENCE_REQUIRED === 'true'`, `LAB_TRUSTED_SIGNERS_JSON` parse → `Record<string,string>` via `parseTrustedSigners` with `{}` default + throw on malformed JSON)
- Modify: `src/orchestrator/app-services.ts` (`signedEvidence: SignedEvidenceProviderPort;`, `trustedSigners: Record<string,string>;`, `paperEvidenceRequired: boolean;`)
- Modify: `src/composition.ts` (wire `selectSignedEvidence(process.env)`; boot-fail guard; pass trustedSigners + paperEvidenceRequired)
- Test: `src/config/env.test.ts` (extend) + a composition-guard test or a focused unit on the guard function

**Interfaces:**
- Produces: `parseTrustedSigners(raw: string | undefined): Record<string,string>` (default `{}`; throw `/LAB_TRUSTED_SIGNERS_JSON/` on invalid JSON or non-string values). Composition boot-fail: when `env.LAB_PAPER_EVIDENCE_REQUIRED === true && !signedEvidence.available` → `throw new Error('LAB_PAPER_EVIDENCE_REQUIRED=true but LAB_SIGNED_EVIDENCE_SOURCE=none — refusing to boot a worker that would quarantine every submission')` [I1 boot-half]. Place it next to `validatePaperWindowPolicy(paperWindowPolicy)` (composition.ts:295), BEFORE db/queue construction.

- [ ] **Step 1: Failing tests** — `parseTrustedSigners`: valid map round-trips; `{}` on undefined; throws on malformed. Composition guard: `LAB_PAPER_EVIDENCE_REQUIRED=true` + no `LAB_SIGNED_EVIDENCE_SOURCE` (→none) → boot throws; `=true` + `fixture`+test → boots. (Guard test: extract the guard into a small pure `assertEvidenceReadiness(evidenceRequired, available)` in composition-support or test it via a thin composition entrypoint — pick the cheapest honest path; if composeRuntime is too heavy to unit-test, extract `assertEvidenceReadiness` and unit-test that + call it in composeRuntime.)
- [ ] **Step 2-4:** implement env + AppServices fields + composition wiring + guard, gates.
- [ ] **Step 5: Commit** `feat(research): TrustedSigners config + LAB_PAPER_EVIDENCE_REQUIRED fail-closed boot guard + signedEvidence wiring`

---

### Task 5: Additive `evidenceArtifactRef` in the intake request

**Files:**
- Modify: `src/adapters/platform/paper-intake.port.ts` (`SubmitProvenCandidateArgs` += `readonly evidenceArtifactRef?: string;`; `buildPaperIntakeRequest` appends it to `artifactRefs` when present)
- Test: `src/adapters/platform/paper-intake.port.test.ts` (extend, or create if absent)

**Interfaces:**
- Consumes: nothing new. Produces: `SubmitProvenCandidateArgs.evidenceArtifactRef?`.

- [ ] **Step 1: Failing tests**:

```ts
it('appends evidenceArtifactRef to artifactRefs when present', () => {
  const req = buildPaperIntakeRequest({ ...baseArgs(), evidenceArtifactRef: 'sha256:ev' });
  expect(req.evidence.artifactRefs).toEqual(['sha256:bundle', 'sha256:ev']);
});
it('omits it → artifactRefs byte-identical to prior behavior', () => {
  const req = buildPaperIntakeRequest(baseArgs());
  expect(req.evidence.artifactRefs).toEqual(['sha256:bundle']);
});
```

- [ ] **Step 2: RED** → **Step 3: Implement** — `artifactRefs: args.evidenceArtifactRef ? [args.bundle.bundleHash, args.evidenceArtifactRef] : [args.bundle.bundleHash]`. **Step 4:** gates. **Step 5: Commit** `feat(intake): additive evidenceArtifactRef in buildPaperIntakeRequest artifactRefs`

---

### Task 6: `paper.start` integration — provide → verify → CAS → ref [I1, I3]

**Files:**
- Modify: `src/orchestrator/handlers/paper-start.handler.ts` (between the CAS bytes-put/champion-submission and `submitProvenCandidate`, L96–120)
- Test: `src/orchestrator/handlers/paper-start.handler.test.ts` (extend)

**Interfaces:**
- Consumes: `services.signedEvidence` (Task 2/4), `verifySignedEvidence` (Task 3), `services.trustedSigners`, `services.paperEvidenceRequired`, `services.artifacts.put`.

Flow (after `args = buildChampionSubmission(...)`, before submit):

```ts
let evidenceArtifactRef: string | undefined;
if (services.signedEvidence.available) {
  const scope = { from: wfo.datasetScope.period.from, to: wfo.datasetScope.period.to };
  const evidence = await services.signedEvidence.provide({
    backtesterRunId: variantRun.platformRunId, bundleHash: bundle.bundleHash,
    datasetRef: wfo.datasetScope.datasetId, window: scope,
    symbols: wfo.datasetScope.symbols, timeframe: wfo.datasetScope.timeframe,
  });
  if (!evidence) {
    if (services.paperEvidenceRequired) {
      await services.events.append(event(task.id, 'paper.evidence_required', { experimentId, reason: 'provider_returned_null' }));
      return; // [I1] no submit
    }
    // not required (non-079 intake) → fall through, submit without evidence
  } else {
    const check = verifySignedEvidence(evidence, {
      bundleHash: bundle.bundleHash, datasetRef: wfo.datasetScope.datasetId,
      window: { fromMs: Date.parse(wfo.datasetScope.period.from), toMs: Date.parse(wfo.datasetScope.period.to) },
      symbols: wfo.datasetScope.symbols, timeframe: wfo.datasetScope.timeframe,
    }, services.trustedSigners);
    if (!check.ok) {
      await services.events.append(event(task.id, 'paper.evidence_rejected', { experimentId, reason: check.reason }));
      return; // [I1]+[I3] no submit, no ref
    }
    const evRef = await services.artifacts.put(JSON.stringify(evidence), { kind: 'signed_backtest_evidence', mime_type: 'application/json', producer: 'paper-start-handler' });
    evidenceArtifactRef = evRef.content_hash; // [I3] ref only AFTER verify passes
  }
} else if (services.paperEvidenceRequired) {
  // defense-in-depth (boot guard should already have failed): never submit unsigned to a 079 intake
  await services.events.append(event(task.id, 'paper.evidence_required', { experimentId, reason: 'provider_unavailable' }));
  return;
}
const res = await services.paperIntake.submitProvenCandidate({ ...args, ...(evidenceArtifactRef ? { evidenceArtifactRef } : {}) });
```

- [ ] **Step 1: Failing tests** (extend fixture: add `signedEvidence`/`trustedSigners`/`paperEvidenceRequired` to the fake services):
  - **[I1a]** `paperEvidenceRequired=true` + provider `available=false` → `paper.evidence_required`, `submitProvenCandidate` NOT called.
  - **[I1b]** `paperEvidenceRequired=true` + provide→null → `paper.evidence_required`, no submit.
  - **[I3a]** provide returns evidence but verify FAILS (tampered/wrong scope) → `paper.evidence_rejected`, NO artifacts.put of evidence (assert no `signed_backtest_evidence` put), NO submit.
  - **[I3b]** provide + verify OK → evidence put to CAS (content_hash captured), `submitProvenCandidate` called with `evidenceArtifactRef === that content_hash`, submission proceeds.
  - **back-compat**: `available=false` + `paperEvidenceRequired=false` → submit called WITHOUT evidenceArtifactRef (old behavior byte-identical).
- [ ] **Step 2: RED** → **Step 3: Implement** → **Step 4:** gates (paper-start tests numerous — all green). **Step 5: Commit** `feat(orchestrator): paper.start attaches signed evidence only after local verify (fail-closed when required)`

---

### Task 7: Backtester handoff doc + env docs + integration test

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-backtester-sign-real-run-evidence-handoff.md`
- Create: `src/orchestrator/handlers/signed-evidence-flow.integration.test.ts`
- Modify: `.env.example` (`LAB_SIGNED_EVIDENCE_SOURCE=none`, `LAB_PAPER_EVIDENCE_REQUIRED=false`, `LAB_ALLOW_FIXTURE_EVIDENCE=`, `LAB_TRUSTED_SIGNERS_JSON=` with comments) + docker-compose worker passthrough for the four vars

**Handoff doc** (mirror `2026-07-03-platform-close-reason-enum-handoff.md` structure): Why / Current gap (cite file:line: `signEvidence` CLI-only with no run-pipeline callers, `produce-evidence.mts` signs a fixture with `TODO(real-bundle)`, no `/v1/runs/:id/evidence`, `RunResultSummary.evidence` is seed/contractVersion) / Change (backtester: sign the REAL passed run's evidence over `buildEvidenceBody({backtesterRunId, bundleHash=sha256(lab-submitted bundle bytes), verdict, scope, keyId})`; expose it fetchable — evidence artifact id in `/v1/runs/:id/result` OR `GET /v1/runs/:id/evidence`; **ALSO publish the backtester's SPKI public-key PEM** so lab's `LAB_TRUSTED_SIGNERS_JSON` can carry a real entry for `bt-ed25519-cb1661aa4bcbfff8` — today only the keyId string exists in-repo, not the pubkey material; **AND export `canonicalizeEvidenceBody` + `SignedBacktestEvidence` from a consumable SDK** so lab drops its vendored copy) / Acceptance / Lab-side contract (the `http` provider wiring point).

**Integration test**: on in-memory infra — seed a champion (wfo PAPER_CANDIDATE + baseline + members + runs, as paper-start tests do) + a fixture `signedEvidence` provider (via `buildFixtureSignedEvidence` matching the champion scope) + matching `trustedSigners` → run `paperStartHandler` → assert: evidence verified, evidence JSON in the CAS, `submitProvenCandidate` (fake transport) received `evidence.artifactRefs` containing the evidence content-hash ref, submission admitted.

- [ ] **Step 1:** integration test (may pass on first run — say so honestly). **Step 2:** handoff doc + env/docker. **Step 3:** FULL gates (`npm run typecheck` + `npm test` 0 failed). **Step 4: Commit** `feat(research): signed-evidence integration test + backtester handoff (sign real run, publish pubkey, export SDK canonicalizer) + env docs`

---

## Self-review notes

- Spec coverage: §2 Deliverable A→Task 7; §3 provider+guards→Tasks 2/4; §4.3 canonicalizer/verify→Tasks 1/3; §4a fail-closed→Tasks 4/6; §4b flow→Task 6; §4.5 artifactRefs→Task 5; §5 tests→embedded; §6 acceptance→Tasks 6/7.
- Three acceptance invariants explicitly tested: I1 (Task 4 boot guard + Task 6 handler tests I1a/I1b), I2 (Task 2 fixture prod-guard), I3 (Task 6 I3a/I3b — ref only after verify).
- Verify-at-implement flagged: whether composeRuntime is unit-testable or needs an extracted `assertEvidenceReadiness` (Task 4); Task 2/3 ordering (fixture builder lives in Task 3 — implement Task 3's builder before Task 2's fixture provider, or inline+refactor).
- Type consistency: `EvidenceCheckScope`/`SignedEvidenceProvideArgs` window shapes intentionally differ — provider takes `{from,to}` ISO (matches DatasetScope.period), verify takes `{fromMs,toMs}` epoch (matches signed body); paper.start converts via `Date.parse`. Documented in Task 6.
- No migration: evidenceArtifactRef rides the request, not the ledger (YAGNI).
