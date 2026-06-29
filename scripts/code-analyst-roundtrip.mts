/**
 * GATED round-trip eval (ВНЕ vitest): curated long_oi КОД → code-analyst → профиль → builder →
 * бандл → платформенный prove_bundle vs curated. Печатает профиль-сводку + вердикт.
 * НЕ ассертит proven — любой исход валиден (эмпирический).
 *
 * Запуск:
 *   PLATFORM_REPO_PATH=/abs/path/trading-platform \
 *   MODEL_PROVIDER=openrouter \
 *   OPENROUTER_API_KEY=<key> \
 *   STRATEGY_ANALYST_MODEL=openrouter/openai/gpt-5.5 \
 *   STRATEGY_BUILDER_MODEL=openrouter/openai/gpt-5.5 \
 *   npx -y tsx scripts/code-analyst-roundtrip.mts
 *
 * Переменные окружения:
 *   PLATFORM_REPO_PATH        — абс. путь к trading-platform (default: ../trading-platform).
 *                               Должен содержать scripts/prove_bundle.mjs.
 *   MODEL_PROVIDER            — anthropic | openai | openrouter
 *   ANTHROPIC_API_KEY /
 *   OPENAI_API_KEY /
 *   OPENROUTER_API_KEY        — ключ выбранного провайдера
 *   STRATEGY_ANALYST_MODEL    — model id для аналитика (default: anthropic/claude-opus-4-5-20251101)
 *   STRATEGY_BUILDER_MODEL    — model id для билдера  (default: anthropic/claude-opus-4-5-20251101)
 *
 * Предусловие:
 *   - В trading-platform выполнен `npm run build` (prove_bundle.mjs грузит dist).
 *   - SDK ≥ 0.4.0 (market-tape authoring-doc).
 *
 * Typecheck (файл вне tsconfig include — типизация вручную, зеркало prove-builder-loop.mts):
 *   npx tsc --noEmit --module nodenext --moduleResolution nodenext \
 *     --target es2022 --strict --allowImportingTsExtensions --skipLibCheck \
 *     scripts/code-analyst-roundtrip.mts
 */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readCodeDir } from '../src/adapters/code-source/read-code-dir.ts';
import { buildCodeSource } from '../src/domain/code-source.ts';
import { composeMastra } from '../src/mastra/compose-mastra.ts';
import type { MastraCompositionEnv } from '../src/mastra/compose-mastra.ts';
import { MastraStrategyAnalyst } from '../src/adapters/analyst/mastra-strategy-analyst.ts';
import { MastraStrategyBuilder } from '../src/adapters/builder/mastra-strategy-builder.ts';
import { createStrategyBuilderAgent } from '../src/mastra/agents/strategy-builder.agent.ts';
import { assembleStrategyBundle } from '../src/domain/strategy-bundle.ts';
import { createShellBundleProver } from '../src/proof/shell-bundle-prover.ts';
import { getAuthoringDoc } from '@trading-backtester/sdk/builder';
import { resolveLanguageModel, MODEL_PROVIDERS } from '../src/adapters/llm/model-provider.ts';
import type { ModelProviderEnv, ModelProvider } from '../src/adapters/llm/model-provider.ts';
import { STRATEGY_PROFILE_CONTRACT_VERSION } from '../src/domain/strategy-profile.ts';
import type { StrategyProfile } from '../src/domain/strategy-profile.ts';
import { sourceFingerprint } from '../src/domain/fingerprint.ts';

// ── env validation ────────────────────────────────────────────────────────────

const platformRepo =
  process.env['PLATFORM_REPO_PATH'] ?? resolve(process.cwd(), '../trading-platform');
const longOiDir = join(platformRepo, 'src/strategies/long_oi');
const cli = join(platformRepo, 'scripts/prove_bundle.mjs');

const rawProvider = process.env['MODEL_PROVIDER'];
if (!rawProvider) {
  throw new Error('MODEL_PROVIDER env is required (anthropic | openai | openrouter)');
}
if (!(MODEL_PROVIDERS as readonly string[]).includes(rawProvider)) {
  throw new Error(
    `MODEL_PROVIDER="${rawProvider}" is not valid; expected one of: ${MODEL_PROVIDERS.join(' | ')}`,
  );
}

const modelEnv: ModelProviderEnv = {
  MODEL_PROVIDER: rawProvider as ModelProvider,
  ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
  OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
  OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
};

const analystModelId =
  process.env['STRATEGY_ANALYST_MODEL'] ?? 'anthropic/claude-opus-4-5-20251101';
const builderModelId =
  process.env['STRATEGY_BUILDER_MODEL'] ?? 'anthropic/claude-opus-4-5-20251101';

// ── composeMastra — analyst real; все остальные = fake ───────────────────────

const env: MastraCompositionEnv = {
  ...modelEnv,
  STRATEGY_ANALYST_ADAPTER: 'mastra',
  STRATEGY_ANALYST_MODEL: analystModelId,
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
const aEntry = runtime.agents.analyst;
if (!aEntry) throw new Error('analyst agent was not composed (check STRATEGY_ANALYST_ADAPTER=mastra)');
const analyst = new MastraStrategyAnalyst(aEntry.agent, aEntry.label);

// ── 1) curated long_oi код → FILE-marked source ──────────────────────────────

const files = readCodeDir(longOiDir);
const content = buildCodeSource(files);

process.stderr.write(
  `[roundtrip] analyst model=${analystModelId}  files=${files.length}  bytes=${content.length}\n`,
);
process.stderr.write('[roundtrip] calling analyst.analyze({kind:"bot_code"})...\n');

// ── 2) real analyst → AnalystProfileOutput ───────────────────────────────────

const profileOut = await analyst.analyze({ kind: 'bot_code', content });

// ── 3) wrap → StrategyProfile (паттерн зеркалит regen-long-oi-profile.mts) ──

const fp = sourceFingerprint('bot_code', content);
const now = new Date().toISOString();

const profile: StrategyProfile = {
  id: randomUUID(),
  version: 1,
  sourceKind: 'bot_code',
  sourceFingerprint: fp,
  direction: profileOut.direction,
  coreIdea: profileOut.coreIdea,
  requiredMarketFeatures: profileOut.requiredMarketFeatures,
  confidence: profileOut.confidence,
  unknowns: profileOut.unknowns,
  profile: profileOut,
  sourceArtifactRef: {
    artifact_id: randomUUID(),
    uri: `artifacts/strategy_source/${fp}`,
    content_hash: fp,
    kind: 'strategy_source',
    size_bytes: Buffer.byteLength(content, 'utf8'),
    mime_type: 'text/plain',
    created_at: now,
    producer: 'scripts/code-analyst-roundtrip.mts',
    metadata: { sourceKind: 'bot_code', uri: null, title: null },
  },
  contractVersion: STRATEGY_PROFILE_CONTRACT_VERSION,
  createdAt: now,
  updatedAt: now,
};

// ── 4) real builder → StrategyBuilderOutput → assembled bundle ───────────────

const resolved = resolveLanguageModel(modelEnv, builderModelId);
const authoringDoc = getAuthoringDoc('strategy');
const builderAgent = createStrategyBuilderAgent({ model: resolved.model, authoringDoc });
const builder = new MastraStrategyBuilder(builderAgent, resolved.label);

process.stderr.write(`[roundtrip] builder model=${resolved.label}\n`);
process.stderr.write('[roundtrip] calling builder.build()...\n');

const out = await builder.build({
  spec: { description: 'long oi rebound (code-analyst round-trip)' },
  authoringDoc,
  profile,
});
const bundle = await assembleStrategyBundle(out);

// ── 5) platform prove_bundle vs curated ──────────────────────────────────────

process.stderr.write('[roundtrip] running shell prover...\n');
const verdict = await createShellBundleProver({ cli }).prove(bundle.source);

// ── print profile summary + verdict ──────────────────────────────────────────

// eslint-disable-next-line no-console
console.log(
  '[roundtrip] profile summary:',
  JSON.stringify(
    {
      direction: profileOut.direction,
      coreIdea: profileOut.coreIdea,
      confidence: profileOut.confidence,
      params: profileOut.parameters.length,
      entryConditions: profileOut.entryConditions.length,
      requiredMarketFeatures: profileOut.requiredMarketFeatures,
      unknowns: profileOut.unknowns.length,
    },
    null,
    2,
  ),
);

// eslint-disable-next-line no-console
console.log('[roundtrip] verdict:', JSON.stringify(verdict, null, 2));
