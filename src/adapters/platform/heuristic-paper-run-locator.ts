import type { PaperRunLocatorPort } from '../../ports/paper-run-locator.port.ts';
import type { BotResultsReadPort } from '../../ports/bot-results-read.port.ts';

/**
 * TEMPORARY heuristic join — replaced by the platform candidateId->runId link per handoff doc;
 * seam isolated here by design. Matches the newest live paper run whose strategy name equals the
 * requested name and whose startedAtMs is after the submission time. This is a best-effort
 * heuristic (name + time proximity), not an authoritative identity join — swap the platform link
 * in by replacing only this adapter, the port shape stays stable.
 */
export class HeuristicPaperRunLocator implements PaperRunLocatorPort {
  private readonly botResults: Pick<BotResultsReadPort, 'listBotRuns'>;

  constructor(botResults: Pick<BotResultsReadPort, 'listBotRuns'>) {
    this.botResults = botResults;
  }

  async locate(args: { strategyName: string; submittedAtMs: number }): Promise<{ runId: string; startedAtMs: number } | null> {
    const runs = await this.botResults.listBotRuns({ mode: 'paper' });
    const candidates = runs
      .filter((run) => run.strategy.name === args.strategyName && run.startedAtMs > args.submittedAtMs)
      .slice()
      .sort((a, b) => b.startedAtMs - a.startedAtMs);

    const best = candidates[0];
    if (!best) return null;
    return { runId: best.runId, startedAtMs: best.startedAtMs };
  }
}
