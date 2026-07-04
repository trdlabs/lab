import { describe, it, expect } from 'vitest';
import { HeuristicPaperRunLocator } from './heuristic-paper-run-locator.ts';
import type { BotResultsReadPort, BotRunRecord } from '../../ports/bot-results-read.port.ts';

function makeRun(overrides: Partial<BotRunRecord>): BotRunRecord {
  return {
    runId: 'run-default',
    mode: 'paper',
    status: 'running',
    bundleId: null, strategy: { name: 'long_oi', version: '1' },
    startedAtMs: 1_000,
    finishedAtMs: null,
    lastSeenMs: 1_000,
    symbols: ['BTCUSDT'],
    ...overrides,
  };
}

function fakeBotResults(runs: readonly BotRunRecord[]): Pick<BotResultsReadPort, 'listBotRuns'> {
  return {
    listBotRuns: async () => runs,
  };
}

describe('HeuristicPaperRunLocator', () => {
  it('matches a run with the same strategy name started after submission', async () => {
    const run = makeRun({ runId: 'run-1', bundleId: null, strategy: { name: 'long_oi', version: '1' }, startedAtMs: 2_000 });
    const locator = new HeuristicPaperRunLocator(fakeBotResults([run]));

    const result = await locator.locate({ strategyName: 'long_oi', submittedAtMs: 1_000 });

    expect(result).toEqual({ runId: 'run-1', startedAtMs: 2_000 });
  });

  it('ignores runs that started before the submission time', async () => {
    const run = makeRun({ runId: 'run-early', bundleId: null, strategy: { name: 'long_oi', version: '1' }, startedAtMs: 500 });
    const locator = new HeuristicPaperRunLocator(fakeBotResults([run]));

    const result = await locator.locate({ strategyName: 'long_oi', submittedAtMs: 1_000 });

    expect(result).toBeNull();
  });

  it('ignores runs with a different strategy name', async () => {
    const run = makeRun({ runId: 'run-other', bundleId: null, strategy: { name: 'short_oi', version: '1' }, startedAtMs: 2_000 });
    const locator = new HeuristicPaperRunLocator(fakeBotResults([run]));

    const result = await locator.locate({ strategyName: 'long_oi', submittedAtMs: 1_000 });

    expect(result).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    const locator = new HeuristicPaperRunLocator(fakeBotResults([]));

    const result = await locator.locate({ strategyName: 'long_oi', submittedAtMs: 1_000 });

    expect(result).toBeNull();
  });

  it('picks the newest startedAtMs when two candidates match', async () => {
    const older = makeRun({ runId: 'run-older', bundleId: null, strategy: { name: 'long_oi', version: '1' }, startedAtMs: 2_000 });
    const newer = makeRun({ runId: 'run-newer', bundleId: null, strategy: { name: 'long_oi', version: '1' }, startedAtMs: 3_000 });
    const locator = new HeuristicPaperRunLocator(fakeBotResults([older, newer]));

    const result = await locator.locate({ strategyName: 'long_oi', submittedAtMs: 1_000 });

    expect(result).toEqual({ runId: 'run-newer', startedAtMs: 3_000 });
  });
});
