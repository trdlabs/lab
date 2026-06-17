import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BotResultsReadPort, BotRunsFilter, BotRunRecord, ClosedTrade, RunSummary,
} from '../../ports/bot-results-read.port.ts';

/** Reads Surface-A-shaped JSON fixtures (port-shaped arrays/object) from a directory. Dev/offline use. */
export class FixtureBotResultsAdapter implements BotResultsReadPort {
  constructor(private readonly dir: string) {}

  private read<T>(file: string): T {
    return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T;
  }

  async listBotRuns(_filter?: BotRunsFilter): Promise<readonly BotRunRecord[]> {
    return this.read<BotRunRecord[]>('runs.json');
  }
  async getClosedTrades(_runId: string): Promise<readonly ClosedTrade[]> {
    return this.read<ClosedTrade[]>('trades.json');
  }
  async getRunSummary(_runId: string): Promise<RunSummary> {
    return this.read<RunSummary>('summary.json');
  }
}
