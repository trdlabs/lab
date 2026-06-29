import { fileURLToPath } from 'node:url';
import type { TradeEvidenceReadPort } from '../../ports/trade-evidence-read.port.ts';
import { MockTradeEvidenceAdapter } from './mock-trade-evidence.adapter.ts';
import { FixtureTradeEvidenceAdapter } from './fixture-trade-evidence.adapter.ts';
import { HttpTradeEvidenceAdapter } from './http-trade-evidence.adapter.ts';
import { OpsReadClient } from './ops-read-client.ts';
import { parseBotResultsIntegration } from './select-bot-results.ts';

function defaultFixtureDir(): string {
  return fileURLToPath(new URL('./__fixtures__/trade-evidence', import.meta.url));
}

/** Boot-safe selector for the trade-evidence read surface — same ops.3 axis as bot-results
 *  (`LAB_BOT_RESULTS_INTEGRATION`), reusing the same OpsReadClient config on the http path. */
export function selectTradeEvidence(source: NodeJS.ProcessEnv): TradeEvidenceReadPort {
  const integration = parseBotResultsIntegration(source.LAB_BOT_RESULTS_INTEGRATION);
  if (integration === 'http') {
    return new HttpTradeEvidenceAdapter(new OpsReadClient({
      baseUrl: source.LAB_OPS_READ_URL ?? 'http://127.0.0.1:8839',
      token: source.LAB_OPS_READ_TOKEN ?? '',
    }));
  }
  if (integration === 'fixture') {
    return new FixtureTradeEvidenceAdapter(source.LAB_OPS_READ_FIXTURE_DIR ?? defaultFixtureDir());
  }
  return new MockTradeEvidenceAdapter();
}
