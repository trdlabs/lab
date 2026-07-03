# Lab handoff prompt — attach SIGNED backtest evidence to paper-intake submissions

> Paste this into the **trading-lab** instance. Lab owns the implementation; trading-platform enforces the contract below (platform feature 079, live on the VPS intake). Convention mirrors the platform-direction handoffs in this directory.

## What changed on the platform (079, 2026-07-03)

The VPS intake now runs the 043 trust-model verifier (`BT_EVIDENCE_ARTIFACTS_DIR` is set): every `submitPaperCandidate` is checked for a **signed backtest evidence artifact**. Admission matrix (fail-closed):

- no artifact found under any `evidence.artifactRefs` entry → **quarantined** (`evidence_resolver_unavailable`)
- signature invalid / unknown keyId → **rejected** (`evidence_signature_invalid`)
- `body.verdict !== 'passed'` → **rejected** (`backtest_not_passed`)
- `body.bundleHash` ≠ sha256 of the submitted bundle bytes → **rejected** (hash-pin)
- `body.{datasetRef,window,symbols,timeframe}` ≠ `evidence.{...}` of the submission → **rejected** (scope mismatch)

Today lab's `buildPaperIntakeRequest` sends `artifactRefs: [bundleHash]` and no evidence file → every submission would now be **quarantined**. Nothing in-flight breaks (lab hasn't pointed `LAB_PAPER_INTAKE_URL` at the VPS yet), but the bridge must be extended before the first real cycle.

## Task: produce + deliver the signed evidence artifact per submission

1. **Producer**: the backtester already signs evidence — `apps/backtester/scripts/produce-evidence.mts` (Ed25519 detached over `canonical(body)`, key from `BT_EVIDENCE_SIGNING_KEY`; its public key `bt-ed25519-cb1661aa4bcbfff8` is committed in the platform allowlist since the 2026-06-29 handshake). The WFO/champion run that justifies the submission must yield `SignedBacktestEvidence` JSON: `{ body: { schema: 'backtest-evidence/v1', backtesterRunId, bundleHash, verdict, datasetRef, window, symbols, timeframe, keyId }, signature }`.
2. **Delivery**: platform resolves artifacts as files `<ref>.json` in its inbox (`/app/data/artifacts-inbox`, docker volume `trading-platform-vps_artifacts-inbox`; lab already delivers bundle bytes there over ssh). `ref` = the content-hash you put into `evidence.artifactRefs` (e.g. `sha256:<hex>` of the canonical evidence JSON — any stable ref works as long as file name matches).
3. **Request**: `evidence.artifactRefs` must include that evidence ref (keep the bundle hash entry as well if you like — the verifier scans all refs and uses the first resolvable evidence artifact). CRITICAL: the submission's `evidence.{datasetRef, window, symbols, timeframe}` must EXACTLY equal the signed `body` scope, and the submitted bundle bytes must hash to `body.bundleHash` — otherwise reject.

## Acceptance

- A real WFO champion submission against the VPS intake returns `admitted` (not quarantined), with the verifier active.
- A tampered artifact (any byte of body changed) → `rejected: evidence_signature_invalid` (negative test in lab CI with a fake key via platform's `TRUSTED_SIGNERS_JSON`, or unit-level against the SDK types).
