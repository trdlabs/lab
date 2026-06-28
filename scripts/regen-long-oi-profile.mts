// scripts/regen-long-oi-profile.mts
// Regenerates src/adapters/builder/fixtures/long-oi-profile.json by running the
// real MastraStrategyAnalyst once against docs/fixtures/strategies/long-oi-strategy-source.md.
//
// REQUIRES a real LLM API key (e.g. ANTHROPIC_API_KEY + MODEL_PROVIDER=anthropic).
// NOT executed in pnpm check — run manually before F2b when a key is available.
//
// Usage:
//   ANTHROPIC_API_KEY=<key> MODEL_PROVIDER=anthropic \
//     npx tsx scripts/regen-long-oi-profile.mts \
//     --model anthropic/claude-opus-4-5-20251101
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeMastra } from '../src/mastra/compose-mastra.ts';
import type { MastraCompositionEnv } from '../src/mastra/compose-mastra.ts';
import { MastraStrategyAnalyst } from '../src/adapters/analyst/mastra-strategy-analyst.ts';
import { sourceFingerprint } from '../src/domain/fingerprint.ts';
import { STRATEGY_PROFILE_CONTRACT_VERSION } from '../src/domain/strategy-profile.ts';
import type { ModelProvider, ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_PATH = join(__dirname, '../docs/fixtures/strategies/long-oi-strategy-source.md');
const OUT_PATH = join(__dirname, '../src/adapters/builder/fixtures/long-oi-profile.json');

function modelEnv(): ModelProviderEnv {
  const provider = process.env['MODEL_PROVIDER'];
  if (!provider) throw new Error('MODEL_PROVIDER env var is required (anthropic|openai|openrouter)');
  return {
    MODEL_PROVIDER: provider as ModelProvider,
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'anthropic/claude-opus-4-5-20251101' },
    },
  });
  const modelId = values['model']!;

  const baseEnv = modelEnv();
  const env: MastraCompositionEnv = {
    ...baseEnv,
    STRATEGY_ANALYST_ADAPTER: 'mastra',
    STRATEGY_ANALYST_MODEL: modelId,
    RESEARCHER_ADAPTER: 'fake',
    RESEARCHER_MODEL: 'fake',
    CRITIC_ADAPTER: 'fake',
    CRITIC_MODEL: 'fake',
    ENABLE_CRITIC_AGENT: false,
    TURN_INTERPRETER_ADAPTER: 'fake',
    TURN_INTERPRETER_MODEL: 'fake',
    BUILDER_ADAPTER: 'fake',
    BUILDER_MODEL: 'fake',
    STRATEGY_CRITIC_ADAPTER: 'fake',
    STRATEGY_CRITIC_MODE: 'two_stage',
    STRATEGY_CRITIC_MODEL: 'fake',
    STRATEGY_REFINER_MODEL: 'fake',
    PHOENIX_ENABLED: false,
    PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces',
    PHOENIX_PROJECT_NAME: 'trading-lab',
  };

  const runtime = composeMastra(env);
  const entry = runtime.agents.analyst;
  if (!entry) throw new Error('analyst agent was not composed (check STRATEGY_ANALYST_ADAPTER)');
  const analyst = new MastraStrategyAnalyst(entry.agent, entry.label);

  const content = readFileSync(SOURCE_PATH, 'utf8');
  const input = { kind: 'manual_description' as const, content };

  process.stderr.write(`[regen] model=${modelId}  source=${SOURCE_PATH}\n`);
  process.stderr.write('[regen] calling analyst.analyze (one real LLM call)...\n');

  const profileOut = await analyst.analyze(input);

  const fingerprint = sourceFingerprint('manual_description', content);
  const now = new Date().toISOString();

  const profile = {
    id: randomUUID(),
    version: 1,
    sourceKind: 'manual_description',
    sourceFingerprint: fingerprint,
    direction: profileOut.direction,
    coreIdea: profileOut.coreIdea,
    requiredMarketFeatures: profileOut.requiredMarketFeatures,
    confidence: profileOut.confidence,
    unknowns: profileOut.unknowns,
    profile: profileOut,
    sourceArtifactRef: {
      artifact_id: randomUUID(),
      uri: `artifacts/strategy_source/${fingerprint}`,
      content_hash: fingerprint,
      kind: 'strategy_source',
      size_bytes: Buffer.byteLength(content, 'utf8'),
      mime_type: 'text/plain',
      created_at: now,
      producer: 'scripts/regen-long-oi-profile.mts',
      metadata: { sourceKind: 'manual_description', uri: null, title: null },
    },
    contractVersion: STRATEGY_PROFILE_CONTRACT_VERSION,
    createdAt: now,
    updatedAt: now,
  };

  writeFileSync(OUT_PATH, JSON.stringify(profile, null, 2) + '\n');
  process.stderr.write(`[regen] written: ${OUT_PATH}\n`);
  process.stdout.write(
    JSON.stringify(
      { ok: true, direction: profile.direction, confidence: profile.confidence, model: modelId },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `regen-long-oi-profile failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
