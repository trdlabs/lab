import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import { CODE_LONG_OI_PROFILE } from '../strategy-analyst/__fixtures__/code-golden.ts';
import { FixtureBotResultsAdapter } from '../../adapters/platform/fixture-bot-results.adapter.ts';
import { FixtureTradeEvidenceAdapter } from '../../adapters/platform/fixture-trade-evidence.adapter.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';

export const RESEARCHER_FIXTURES = {
  'long-oi-vps-2026-06-01': {
    id: 'long-oi-vps-2026-06-01',
    botResultsDir: 'docs/fixtures/bot-results/vps-from-2026-06-01',
  },
} as const;

export type ResearcherFixtureId = keyof typeof RESEARCHER_FIXTURES;

export function resolveResearcherFixture(id: string): (typeof RESEARCHER_FIXTURES)[ResearcherFixtureId] {
  const fixture = RESEARCHER_FIXTURES[id as ResearcherFixtureId];
  if (!fixture) throw new Error(`unknown researcher fixture "${id}" (known: ${Object.keys(RESEARCHER_FIXTURES).join(', ')})`);
  return fixture;
}

export function longOiStrategyProfile(): StrategyProfile {
  return {
    id: 'long-oi-profile',
    version: 1,
    sourceKind: 'bot_code',
    sourceFingerprint: 'sha256:2bdc5389969657cd46ec2500022350e768a0426d8d7bcbb01b14f344157f82b5',
    direction: CODE_LONG_OI_PROFILE.direction,
    coreIdea: CODE_LONG_OI_PROFILE.coreIdea,
    requiredMarketFeatures: CODE_LONG_OI_PROFILE.requiredMarketFeatures,
    confidence: CODE_LONG_OI_PROFILE.confidence,
    unknowns: CODE_LONG_OI_PROFILE.unknowns,
    profile: CODE_LONG_OI_PROFILE,
    sourceArtifactRef: {
      artifact_id: 'fixture-long-oi-code',
      uri: 'docs/fixtures/strategies/long-oi-code',
      content_hash: 'sha256:2bdc5389969657cd46ec2500022350e768a0426d8d7bcbb01b14f344157f82b5',
      kind: 'strategy_source',
      size_bytes: 70863,
      mime_type: 'text/plain',
      created_at: '2026-06-29T21:01:46.487Z',
      producer: 'scripts/regen-from-code.mts',
      metadata: { sourceKind: 'bot_code', uri: null, title: null },
    },
    contractVersion: 'strategy-profile-v1',
    createdAt: '2026-06-29T21:01:46.487Z',
    updatedAt: '2026-06-29T21:01:46.487Z',
  };
}

export async function loadBotResultsFixture(dir: string): Promise<readonly BotRunResultDetail[]> {
  const adapter = new FixtureBotResultsAdapter(fileURLToPath(new URL(`../../../${dir}/`, import.meta.url)));
  const runs = await adapter.listBotRuns();
  return Promise.all(runs.map(async (run) => ({
    run,
    summary: await adapter.getRunSummary(run.runId),
    trades: await adapter.getClosedTrades(run.runId),
  })));
}

export async function loadTradeEvidenceFixture(
  dir: string,
  botResults: readonly BotRunResultDetail[],
  limit = 5,
): Promise<readonly TradeEvidenceBundle[]> {
  const adapter = new FixtureTradeEvidenceAdapter(fileURLToPath(new URL(`../../../${dir}/`, import.meta.url)));
  const tradeIds = botResults
    .flatMap((detail) => detail.trades)
    .filter((trade) => Number(trade.realizedPnl) < 0)
    .sort((a, b) => Number(a.realizedPnl) - Number(b.realizedPnl) || a.tradeId.localeCompare(b.tradeId))
    .slice(0, limit)
    .map((trade) => trade.tradeId);
  if (tradeIds.length === 0) return [];
  return adapter.getTradeEvidence({ tradeIds, minuteWindowBefore: 20, minuteWindowAfter: 180 });
}

export function fingerprintFixture(
  profile: StrategyProfile,
  botResults: readonly BotRunResultDetail[],
  tradeEvidence: readonly TradeEvidenceBundle[] = [],
): string {
  const payload = JSON.stringify({
    profile: profile.sourceFingerprint,
    runs: botResults.map((d) => [d.run.runId, d.summary.closedTrades, d.summary.pnlUsd]),
    tradeEvidence: tradeEvidence.map((bundle) => [bundle.tradeId, bundle.symbol, bundle.closeReason, bundle.lifecycleEvents.length, bundle.minuteContext.length]),
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
