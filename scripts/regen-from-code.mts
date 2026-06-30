// Перегенерация профиля long_oi из КОДА стратегии (kind:'bot_code'), а не из прозы.
// Кормит аналитику весь модуль src/strategies/long_oi/*.ts (вкл. params.ts с DEFAULT_PARAMS).
// Пишет новый профиль в src/adapters/builder/fixtures/long-oi-profile.json (бэкап оригинала рядом).
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { composeMastra } from '../src/mastra/compose-mastra.ts';
import type { MastraCompositionEnv } from '../src/mastra/compose-mastra.ts';
import { MastraStrategyAnalyst } from '../src/adapters/analyst/mastra-strategy-analyst.ts';
import { sourceFingerprint } from '../src/domain/fingerprint.ts';
import { gatherStrategyCode } from '../src/domain/strategy-code.ts';
import { STRATEGY_PROFILE_CONTRACT_VERSION } from '../src/domain/strategy-profile.ts';
import type { ModelProvider, ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Self-contained: read the vendored long_oi code. Override with LONGOI_CODE_DIR for a fresh re-vendor source.
const MODULE_DIR = process.env['LONGOI_CODE_DIR']
  ?? resolve(__dirname, '../docs/fixtures/strategies/long-oi-code');
const OUT_PATH = join(__dirname, '../src/adapters/builder/fixtures/long-oi-profile.json');


function modelEnv(): ModelProviderEnv {
  const provider = process.env['MODEL_PROVIDER'];
  if (!provider) throw new Error('MODEL_PROVIDER env var is required');
  return {
    MODEL_PROVIDER: provider as ModelProvider,
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
  };
}

const modelId = process.env['STRATEGY_ANALYST_MODEL']?.replace(/^"|"$/g, '') ?? 'openrouter/openai/gpt-5.5';
const env: MastraCompositionEnv = {
  ...modelEnv(),
  STRATEGY_ANALYST_ADAPTER: 'mastra',
  STRATEGY_ANALYST_MODEL: modelId,
  RESEARCHER_ADAPTER: 'fake', RESEARCHER_MODEL: 'fake',
  CRITIC_ADAPTER: 'fake', CRITIC_MODEL: 'fake', ENABLE_CRITIC_AGENT: false,
  TURN_INTERPRETER_ADAPTER: 'fake', TURN_INTERPRETER_MODEL: 'fake',
  BUILDER_ADAPTER: 'fake', BUILDER_MODEL: 'fake',
  STRATEGY_CRITIC_ADAPTER: 'fake', STRATEGY_CRITIC_MODE: 'two_stage',
  STRATEGY_CRITIC_MODEL: 'fake', STRATEGY_REFINER_MODEL: 'fake',
  PHOENIX_ENABLED: false,
  PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces',
  PHOENIX_PROJECT_NAME: 'trading-lab',
};

const runtime = composeMastra(env);
const entry = runtime.agents.analyst;
if (!entry) throw new Error('analyst agent not composed');
const analyst = new MastraStrategyAnalyst(entry.agent, entry.label);

const files = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts'))
  .map((name) => ({ name, content: readFileSync(join(MODULE_DIR, name), 'utf8') }));
const content = gatherStrategyCode(files, { pathPrefix: 'src/strategies/long_oi' });
const input = { kind: 'bot_code' as const, content };
process.stderr.write(`[regen-code] model=${modelId} code=${MODULE_DIR} (${Buffer.byteLength(content)} байт)\n`);
process.stderr.write('[regen-code] analyst.analyze(bot_code) — один реальный LLM-вызов...\n');

const profileOut = await analyst.analyze(input);
const fingerprint = sourceFingerprint('bot_code', content);
const now = new Date().toISOString();
const profile = {
  id: randomUUID(), version: 1, sourceKind: 'bot_code', sourceFingerprint: fingerprint,
  direction: profileOut.direction, coreIdea: profileOut.coreIdea,
  requiredMarketFeatures: profileOut.requiredMarketFeatures, confidence: profileOut.confidence,
  unknowns: profileOut.unknowns, profile: profileOut,
  sourceArtifactRef: {
    artifact_id: randomUUID(), uri: `artifacts/strategy_source/${fingerprint}`, content_hash: fingerprint,
    kind: 'strategy_source', size_bytes: Buffer.byteLength(content, 'utf8'), mime_type: 'text/plain',
    created_at: now, producer: 'scripts/regen-from-code.mts',
    metadata: { sourceKind: 'bot_code', uri: null, title: null },
  },
  contractVersion: STRATEGY_PROFILE_CONTRACT_VERSION, createdAt: now, updatedAt: now,
};

if (existsSync(OUT_PATH)) copyFileSync(OUT_PATH, OUT_PATH + '.prose.bak');
writeFileSync(OUT_PATH, JSON.stringify(profile, null, 2) + '\n');
process.stderr.write(`[regen-code] профиль записан → ${OUT_PATH} (бэкап: ${OUT_PATH}.prose.bak)\n`);
process.stderr.write(`[regen-code] unknowns: ${JSON.stringify(profileOut.unknowns)}\n`);
