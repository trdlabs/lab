/**
 * Seed a REAL, PERSISTED `StrategyProfile` for the vendored `long_oi` bot code by running the
 * actual `strategy.onboard` orchestrator path (composeRuntime → strategyOnboardHandler), not a
 * JSON-fixture side channel. Prints the persisted `strategyProfileId` to stdout on success.
 *
 * Unlike scripts/regen-from-code.mts (analyst-only, writes a JSON fixture, never touches the DB),
 * this script goes through the SAME code path the crawler/chat onboarding flow uses:
 *   readCodeDir + buildCodeSource (kind:'bot_code') → strategyOnboardHandler(task, services)
 *     → services.analyst.analyze() → services.strategyProfiles.create()
 * so downstream work (trigger + experiment) can load the profile by id from `strategy_profile`.
 *
 * Idempotent: strategyOnboardHandler dedupes by sourceFingerprint(kind, content) — a re-run
 * against unchanged vendored code is a no-op (emits strategy.onboard.deduped) and this script
 * still looks up + prints the SAME persisted id via findByFingerprint.
 *
 * Run:
 *   DATABASE_URL=postgres://... \
 *   REDIS_URL=redis://... \
 *   STRATEGY_ANALYST_ADAPTER=mastra \
 *   MODEL_PROVIDER=openrouter \
 *   OPENROUTER_API_KEY=<key> \
 *   STRATEGY_ANALYST_MODEL=openrouter/openai/gpt-5.5 \
 *   npx -y tsx scripts/seed-long-oi-profile.mts
 *
 * Environment variables:
 *   DATABASE_URL              — required by composeRuntime (Postgres; strategy_profile table lives here).
 *   REDIS_URL                 — required by composeRuntime (BullMQ queue is wired unconditionally,
 *                                even though this script never enqueues; no jobs are pushed).
 *   STRATEGY_ANALYST_ADAPTER  — MUST be 'mastra' or composeRuntime silently falls back to
 *                                FakeStrategyAnalyst (stub analysis, not a real onboard).
 *   MODEL_PROVIDER            — anthropic | openai | openrouter (validated below; composeRuntime's
 *                                own loadEnv() silently defaults to 'anthropic' on garbage input,
 *                                so we fail fast here instead).
 *   ANTHROPIC_API_KEY /
 *   OPENAI_API_KEY /
 *   OPENROUTER_API_KEY        — key matching the selected MODEL_PROVIDER.
 *   STRATEGY_ANALYST_MODEL    — model id for the analyst (default: openrouter/openai/gpt-5.5,
 *                                same default as scripts/regen-from-code.mts).
 *   LONGOI_CODE_DIR           — override the vendored long_oi code dir (default: below).
 *   STRATEGY_PREFLIGHT_CRITIQUE — optional; loadEnv defaults true, running the (fake-by-default,
 *                                key-free) pre-flight critic before the analyst. Harmless — the
 *                                dedupe fingerprint is computed on the ORIGINAL content, not the
 *                                critic-rewritten text. Set 'false' to skip it entirely.
 *
 * Vendored code dir (same one scripts/regen-from-code.mts reads by default):
 *   docs/fixtures/strategies/long-oi-code/
 *
 * Typecheck (file is OUTSIDE tsconfig include — manual invocation, mirrors
 * scripts/code-analyst-roundtrip.mts / scripts/regen-from-code.mts headers):
 *   npx tsc --noEmit --module nodenext --moduleResolution nodenext \
 *     --target es2022 --strict --allowImportingTsExtensions --skipLibCheck \
 *     scripts/seed-long-oi-profile.mts
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodeDir } from '../src/adapters/code-source/read-code-dir.ts';
import { buildCodeSource } from '../src/domain/code-source.ts';
import { composeRuntime } from '../src/composition.ts';
import { strategyOnboardHandler } from '../src/orchestrator/handlers/strategy-onboard.handler.ts';
import { sourceFingerprint } from '../src/domain/fingerprint.ts';
import { MODEL_PROVIDERS } from '../src/adapters/llm/model-provider.ts';
import type { ResearchTask } from '../src/domain/types.ts';

// ── env validation ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const longOiDir = process.env['LONGOI_CODE_DIR']
  ?? resolve(__dirname, '../docs/fixtures/strategies/long-oi-code');

const rawProvider = process.env['MODEL_PROVIDER'];
if (!rawProvider) {
  throw new Error('MODEL_PROVIDER env is required (anthropic | openai | openrouter)');
}
if (!(MODEL_PROVIDERS as readonly string[]).includes(rawProvider)) {
  throw new Error(
    `MODEL_PROVIDER="${rawProvider}" is not valid; expected one of: ${MODEL_PROVIDERS.join(' | ')}`,
  );
}

if (process.env['STRATEGY_ANALYST_ADAPTER'] !== 'mastra') {
  throw new Error(
    'STRATEGY_ANALYST_ADAPTER=mastra is required — otherwise composeRuntime wires FakeStrategyAnalyst '
    + 'and this would not be a real onboard.',
  );
}

if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL env is required (composeRuntime persists here)');
if (!process.env['REDIS_URL']) throw new Error('REDIS_URL env is required (composeRuntime wires BullMQ unconditionally)');

// ── compose the real runtime (analyst=mastra; everything else composeRuntime defaults to) ────

const { services, pool, queue } = composeRuntime();

try {
  // ── read the vendored long_oi code the same way scripts/code-analyst-roundtrip.mts does ────

  const files = readCodeDir(longOiDir);
  const content = buildCodeSource(files);
  const fingerprint = sourceFingerprint('bot_code', content);

  process.stderr.write(
    `[seed-long-oi] model=${process.env['STRATEGY_ANALYST_MODEL'] ?? '(composeRuntime default)'} `
    + `code=${longOiDir} files=${files.length} bytes=${content.length} fingerprint=${fingerprint}\n`,
  );

  // ── run the REAL strategy.onboard path ────────────────────────────────────────

  const now = new Date().toISOString();
  const task: ResearchTask = {
    id: randomUUID(),
    taskType: 'strategy.onboard',
    source: 'cron',
    correlationId: randomUUID(),
    status: 'running',
    payload: { kind: 'bot_code', content, title: 'long_oi (vendored)' },
    createdAt: now,
    updatedAt: now,
  };

  process.stderr.write('[seed-long-oi] strategyOnboardHandler(task, services)...\n');
  await strategyOnboardHandler(task, services);

  // ── look up + print the persisted id (idempotent: same id on a re-run) ─────────

  const profile = await services.strategyProfiles.findByFingerprint(fingerprint);
  if (!profile) {
    throw new Error(
      `strategyOnboardHandler completed but findByFingerprint(${fingerprint}) returned null — `
      + 'this should be unreachable (the handler always creates-or-dedupes before returning).',
    );
  }

  process.stderr.write(`[seed-long-oi] persisted strategy_profile id=${profile.id}\n`);
  // eslint-disable-next-line no-console
  console.log(profile.id);
} finally {
  await queue.close();
  await pool.end();
}
