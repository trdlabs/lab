import { fileURLToPath } from 'node:url';
import type { BotResultsReadPort } from '../../ports/bot-results-read.port.ts';
import { MockBotResultsAdapter } from './mock-bot-results.adapter.ts';
import { FixtureBotResultsAdapter } from './fixture-bot-results.adapter.ts';
import { HttpOpsReadAdapter } from './http-ops-read.adapter.ts';
import { OpsReadClient } from './ops-read-client.ts';

// Dedicated axis — SEPARATE from the research-transport integration (TRADING_PLATFORM_*).
// research (backtest) and bot-results (live ops.3) are distinct channels and must not be conflated.
export type BotResultsIntegration = 'mock' | 'fixture' | 'http';

/** Validate the env string against the union; fail closed on anything unknown. */
export function parseBotResultsIntegration(raw: string | undefined): BotResultsIntegration {
  if (raw === undefined || raw === '') return 'mock';
  if (raw === 'mock' || raw === 'fixture' || raw === 'http') return raw;
  throw new Error(`LAB_BOT_RESULTS_INTEGRATION must be one of mock|fixture|http, got '${raw}'`);
}

function defaultFixtureDir(): string {
  return fileURLToPath(new URL('./__fixtures__/bot-results', import.meta.url));
}

/** Boot-safe selector for the live bot-results read surface. Reads its OWN env, never process.env directly. */
export function selectBotResults(source: NodeJS.ProcessEnv): BotResultsReadPort {
  const integration = parseBotResultsIntegration(source.LAB_BOT_RESULTS_INTEGRATION);
  if (integration === 'http') {
    return new HttpOpsReadAdapter(new OpsReadClient({
      baseUrl: source.LAB_OPS_READ_URL ?? 'http://127.0.0.1:8839',
      token: source.LAB_OPS_READ_TOKEN ?? '',
    }));
  }
  if (integration === 'fixture') {
    return new FixtureBotResultsAdapter(source.LAB_OPS_READ_FIXTURE_DIR ?? defaultFixtureDir());
  }
  return new MockBotResultsAdapter();
}
