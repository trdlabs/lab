import type {
  TradeEvidenceBundle, TradeEvidenceQuery, TradeEvidenceReadPort, TradeLifecycleEvidence,
} from '../../ports/trade-evidence-read.port.ts';
import type { OpsReadClient } from './ops-read-client.ts';

/** Wire shape of the platform `/ops/trade-evidence` rows (Surface A, ops.3). */
interface TradeEvidenceRow {
  readonly tradeId: string; readonly runId: string; readonly symbol: string; readonly side: 'long' | 'short';
  readonly openedAtMs: number; readonly closedAtMs: number | null;
  readonly entryPrice: string | null; readonly exitPrice: string | null;
  readonly realizedPnl: string; readonly pnlPct: string; readonly closeReason: string | null;
  readonly lifecycle: ReadonlyArray<{
    tsMs: number; type: TradeLifecycleEvidence['type']; price: string | null; qty: string | null; note?: string | null;
  }>;
}

interface PageEnvelope<T> { readonly items: readonly T[]; readonly nextCursor: string | null; }

/** Live TradeEvidenceReadPort over the Ops Read Surface A `/ops/trade-evidence` batch endpoint. */
export class HttpTradeEvidenceAdapter implements TradeEvidenceReadPort {
  private readonly client: OpsReadClient;

  constructor(client: OpsReadClient) { this.client = client; }

  async getTradeEvidence(query: TradeEvidenceQuery): Promise<readonly TradeEvidenceBundle[]> {
    if (query.tradeIds.length === 0) return [];
    const rows: TradeEvidenceRow[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ tradeIds: query.tradeIds.join(',') });
      if (cursor) params.set('cursor', cursor);
      const page = await this.client.get<PageEnvelope<TradeEvidenceRow>>(`/ops/trade-evidence?${params.toString()}`);
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return rows.map((r) => ({
      tradeId: r.tradeId, runId: r.runId, symbol: r.symbol, side: r.side,
      enteredAtMs: r.openedAtMs, closedAtMs: r.closedAtMs,
      entryPrice: r.entryPrice, exitPrice: r.exitPrice,
      realizedPnl: r.realizedPnl, pnlPct: r.pnlPct,
      holdingDurationMs: r.closedAtMs != null ? r.closedAtMs - r.openedAtMs : null,
      closeReason: r.closeReason,
      lifecycleEvents: r.lifecycle.map((e) => ({
        tsMs: e.tsMs, type: e.type, price: e.price ?? null, qty: e.qty ?? null, note: e.note ?? null,
      })),
      minuteContext: [], // dropped — Slice A's per-trade context owns the market window
    }));
  }
}
