/**
 * GATED eval — намеренно ВНЕ tsconfig.json include, поэтому НЕ покрыт tsc/vitest.
 * Typecheck вручную: npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict scripts/prove-builder-loop.mts
 * При дрейфе сигнатур F2a (model-provider / MastraStrategyBuilder) — перепроверить здесь вручную.
 *
 * Gated real-LLM eval (ВНЕ vitest): реальный MastraStrategyBuilder + shell prove_bundle.mjs +
 * замороженный long_oi-профиль → runBuilderProofLoop против реальной СОБРАННОЙ платформы.
 * Печатает ProofOutcome. НЕ ассертит proven — любой исход валиден.
 *
 * Запуск:
 *   PLATFORM_REPO_PATH=/abs/path/trading-platform \
 *   MODEL_PROVIDER=openrouter \
 *   OPENROUTER_API_KEY=<key> \
 *   STRATEGY_BUILDER_MODEL=openai/gpt-4o \
 *   npx -y tsx scripts/prove-builder-loop.mts
 *
 * Предусловие: в платформе выполнен `npm run build` (CLI грузит dist).
 *
 * Переменные окружения:
 *   PLATFORM_REPO_PATH           — абс. путь к trading-platform (содержит scripts/prove_bundle.mjs)
 *   MODEL_PROVIDER               — anthropic | openai | openrouter
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY — ключ провайдера
 *   STRATEGY_BUILDER_MODEL       — model id, например claude-3-5-sonnet-20241022 (дефолт)
 *   STRATEGY_BUILDER_AUTHORING_DOC — опционально: путь к SDK authoring doc (встраивается в system prompt)
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuilderProofLoop } from '../src/proof/builder-proof-loop.ts';
import { createShellBundleProver } from '../src/proof/shell-bundle-prover.ts';
import { resolveLanguageModel, MODEL_PROVIDERS } from '../src/adapters/llm/model-provider.ts';
import type { ModelProviderEnv, ModelProvider } from '../src/adapters/llm/model-provider.ts';
import { createStrategyBuilderAgent } from '../src/mastra/agents/strategy-builder.agent.ts';
import { MastraStrategyBuilder } from '../src/adapters/builder/mastra-strategy-builder.ts';
import type { StrategyProfile } from '../src/domain/strategy-profile.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const platformRepo =
  process.env['PLATFORM_REPO_PATH'] ?? resolve(__dirname, '../../trading-platform');
const cli = join(platformRepo, 'scripts/prove_bundle.mjs');

// Frozen long_oi profile fixture.
// Outer object is StrategyProfile; MastraStrategyBuilder.build() reads profile.profile internally.
const profileFixture = JSON.parse(
  readFileSync(join(__dirname, '../src/adapters/builder/fixtures/long-oi-profile.json'), 'utf8'),
) as StrategyProfile;

// M5 is closed by createStrategyBuilderAgent + MastraStrategyBuilder wiring below.
// 1) Resolve LLM model for the strategy builder from env (ModelProviderEnv subset).
const rawProvider = process.env['MODEL_PROVIDER'];
if (!rawProvider) throw new Error('MODEL_PROVIDER env is required (anthropic | openai | openrouter)');
if (!(MODEL_PROVIDERS as readonly string[]).includes(rawProvider)) {
  throw new Error(`MODEL_PROVIDER="${rawProvider}" is not valid; expected one of: ${MODEL_PROVIDERS.join(' | ')}`);
}
const modelEnv: ModelProviderEnv = {
  MODEL_PROVIDER: rawProvider as ModelProvider,
  ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
  OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
  OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
};
const strategyBuilderModelId =
  process.env['STRATEGY_BUILDER_MODEL'] ?? 'claude-3-5-sonnet-20241022';
const resolved = resolveLanguageModel(modelEnv, strategyBuilderModelId);

// Authoring doc: optional SDK reference baked into the agent's system-prompt instructions.
// Empty string = agent works without SDK ref (reduced accuracy, but still runnable).
const authoringDocPath = process.env['STRATEGY_BUILDER_AUTHORING_DOC'];
const authoringDoc = authoringDocPath ? readFileSync(authoringDocPath, 'utf8') : '';

// 3) Real strategy builder — exact constructor: MastraStrategyBuilder(agent, label, opts?)
//    createStrategyBuilderAgent deps: { model: ProviderModel; authoringDoc: string }
const agent = createStrategyBuilderAgent({ model: resolved.model, authoringDoc });
const builder = new MastraStrategyBuilder(agent, resolved.label);

// 4) StrategyBuilderInput: spec (StrategyAuthoringSpec) + authoringDoc + profile (StrategyProfile)
const input = {
  spec: { description: 'long oi rebound (proof eval)' },
  authoringDoc,
  profile: profileFixture,
};

// 5) Run proof loop — prints ProofOutcome; proven is empirical, NOT asserted
const outcome = await runBuilderProofLoop({
  builder,
  prover: createShellBundleProver({ cli }),
  input,
  maxIterations: 5,
});

// eslint-disable-next-line no-console
console.log('[prove-builder-loop] outcome:', JSON.stringify(outcome, null, 2));
