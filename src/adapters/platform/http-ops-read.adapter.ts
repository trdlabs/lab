import type {
  BotResultsReadPort,
  BotRunsFilter,
  BotRunRecord,
  ClosedTrade,
  RunSummary,
  EventsPage,
  DecisionsPage,
} from '../../ports/bot-results-read.port.ts';
import type { OpsReadClient } from './ops-read-client.ts';

/** Surface A page envelope — the only fields the adapter needs to walk pages. */
interface PageEnvelope<T> { readonly items: readonly T[]; readonly nextCursor: string | null; }

/** Live BotResultsReadPort over the Ops Read Surface A (ops.3). Pagination is hidden: each list
 *  method walks the opaque cursor to completion and returns a flat array. */
export class HttpOpsReadAdapter implements BotResultsReadPort {
  constructor(private readonly client: OpsReadClient) {}

  async listBotRuns(filter?: BotRunsFilter): Promise<readonly BotRunRecord[]> {
    const base = new URLSearchParams();
    if (filter?.mode) base.set('mode', filter.mode);
    if (filter?.status) base.set('status', filter.status);
    return this.walk<BotRunRecord>('/ops/runs', base);
  }

  async getClosedTrades(runId: string): Promise<readonly ClosedTrade[]> {
    const base = new URLSearchParams({ runId });
    return this.walk<ClosedTrade>('/ops/trades', base);
  }

  async getRunSummary(runId: string): Promise<RunSummary> {
    return this.client.get<RunSummary>(`/ops/runs/${encodeURIComponent(runId)}/summary`);
  }

  async getOperationalEvents(runId: string, cursor?: string): Promise<EventsPage> {
    return this.client.get<EventsPage>(this.pagePath('/ops/events', runId, cursor));
  }

  async getDecisionLog(runId: string, cursor?: string): Promise<DecisionsPage> {
    return this.client.get<DecisionsPage>(this.pagePath('/ops/decisions', runId, cursor));
  }

  /** Walk Surface A cursor pages for `path`, carrying the fixed query params in `base`. */
  private async walk<T>(path: string, base: URLSearchParams): Promise<readonly T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams(base);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const page = await this.client.get<PageEnvelope<T>>(`${path}${qs ? `?${qs}` : ''}`);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  private pagePath(path: string, runId: string, cursor?: string): string {
    const params = new URLSearchParams({ runId });
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    return `${path}?${qs}`;
  }
}
