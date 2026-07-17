#!/usr/bin/env node
// scripts/embargo-enforcement-probe.mjs — primary generation-lane embargo-enforcement probe
// (F5a). Imports scrubMetricsBag / sanitizeRetryFeedback from a given build of
// src/research/outcome-embargo.ts and asserts a held-out marker never survives scrubbing.
// Fail-closed: a missing/broken module (no scrubMetricsBag / sanitizeRetryFeedback exports,
// or a scrub that lets the marker through) exits non-zero — never reads as a pass or a skip.
//
// Two callers:
//   - scripts/outcome-embargo-smoke.sh's generation_lane_check (the PRIMARY smoke check):
//     runs this INSIDE the deployed U6 worker container via `docker exec`, pointed at the
//     image's own /app/src/research/outcome-embargo.ts — proves the DEPLOYED artifact
//     enforces the embargo, not just the host checkout.
//   - test/outcome-embargo-smoke.test.ts: runs this against the LOCAL build (host
//     checkout) — the CI-safe substitute for the in-container run above, since a real
//     container is not available in CI.
//
// Required env:
//   EMBARGO_MODULE_PATH — absolute path (or file:// URL) to the outcome-embargo module to
//                          import.
// Optional env:
//   EMBARGO_MARKER       — override the fixture marker string.
//
// Никогда не печатает значение маркера — only whether it leaked.
//
// Invoke with the same type-stripping flag the deployed worker/ingress commands use
// (docker-compose.yml): plain --experimental-strip-types rejects TS parameter properties
// used elsewhere in this codebase, so --experimental-transform-types is required even
// though outcome-embargo.ts itself doesn't use them — matching the working invocation
// avoids a probe that behaves differently from the process it's meant to validate.
//   node --experimental-transform-types scripts/embargo-enforcement-probe.mjs

const MODULE_PATH = process.env.EMBARGO_MODULE_PATH ?? '';
const MARKER = process.env.EMBARGO_MARKER ?? '__HELDOUT_ENFORCEMENT_PROBE_MARKER__';

function fail(msg) {
  process.stderr.write(`[embargo-enforcement-probe] FAIL: ${msg}\n`);
  process.exit(1);
}

if (!MODULE_PATH) fail('EMBARGO_MODULE_PATH is required');

const moduleUrl = MODULE_PATH.startsWith('file://') ? MODULE_PATH : `file://${MODULE_PATH}`;

let mod;
try {
  mod = await import(moduleUrl);
} catch (err) {
  fail(
    `failed to import outcome-embargo module at ${MODULE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const scrubMetricsBag = mod?.scrubMetricsBag;
const sanitizeRetryFeedback = mod?.sanitizeRetryFeedback;

if (typeof scrubMetricsBag !== 'function') {
  fail('scrubMetricsBag is missing (or not a function) on the imported module — deployed embargo enforcement is absent');
}
if (typeof sanitizeRetryFeedback !== 'function') {
  fail('sanitizeRetryFeedback is missing (or not a function) on the imported module — deployed embargo enforcement is absent');
}

let leaked = false;

// scrubMetricsBag: the marker is planted under keys that MUST be recognized as embargoed
// (holdout / qualification / out-of-sample tokens — see embargoCategory in
// outcome-embargo.ts). Three different embargo categories, so a regression in any one
// category still trips the probe.
const bag = {
  ok: 1,
  holdoutSharpe: MARKER,
  nested: { qualification_verdict: MARKER, out_of_sample_pnl: MARKER, fine: 'kept' },
};
const { scrubbed } = scrubMetricsBag(bag);
if (JSON.stringify(scrubbed).includes(MARKER)) {
  process.stderr.write('[embargo-enforcement-probe] FAIL: marker survived scrubMetricsBag (value redacted)\n');
  leaked = true;
}

// sanitizeRetryFeedback: the marker is planted as a non-allowlisted reason — the fail-closed
// allowlist (I-E5) must drop it, since free-text reasons may embed embargoed metric/window text.
const feedback = {
  hypothesisId: 'embargo-probe',
  decision: 'PASS',
  reasons: ['drawdown_regression', `leaked_${MARKER}`],
};
const { feedback: sanitizedFeedback } = sanitizeRetryFeedback(feedback);
if (JSON.stringify(sanitizedFeedback).includes(MARKER)) {
  process.stderr.write('[embargo-enforcement-probe] FAIL: marker survived sanitizeRetryFeedback (value redacted)\n');
  leaked = true;
}

if (leaked) process.exit(1);

process.stdout.write('[embargo-enforcement-probe] PASS: scrubMetricsBag and sanitizeRetryFeedback both scrubbed the marker\n');
process.exit(0);
