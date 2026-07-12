import type { DecisionLogEntry, ClosedTrade } from '../ports/bot-results-read.port.ts';
import type { DecisionExcerpt } from '../ports/researcher.port.ts';

export const DECISION_EXCERPT_CAP = 20;
export const DECISION_PRE_ENTRY_MARGIN_MS = 60_000;

/**
 * Pure filter+map+cap of decision-log entries to the narrow DecisionExcerpt shape. Keeps only
 * entries that fall in a selected losing trade's window [openedAtMs - margin, closedAtMs ?? openedAtMs]
 * AND share its runId. On overlap the first loser in selection order wins (one excerpt per entry).
 * Deterministic order: loser selection index, then tsMs ascending. Never mutates inputs, no clock.
 */
export function toDecisionExcerpts(
  entries: readonly DecisionLogEntry[],
  losers: readonly ClosedTrade[],
  cap: number = DECISION_EXCERPT_CAP,
): DecisionExcerpt[] {
  const windows = losers.map((t) => ({
    tradeId: t.tradeId,
    runId: t.runId,
    lo: t.openedAtMs - DECISION_PRE_ENTRY_MARGIN_MS,
    hi: t.closedAtMs ?? t.openedAtMs,
  }));
  const matched: Array<{ excerpt: DecisionExcerpt; order: number; tsMs: number }> = [];
  for (const e of entries) {
    const order = windows.findIndex((w) => w.runId === e.runId && e.tsMs >= w.lo && e.tsMs <= w.hi);
    if (order === -1) continue;
    matched.push({
      excerpt: {
        runId: e.runId,
        timestampMs: e.tsMs,
        action: e.category,
        reason: e.reason,
        summary: e.safeMessage,
        relatedTradeId: windows[order]!.tradeId,
      },
      order,
      tsMs: e.tsMs,
    });
  }
  matched.sort((a, b) => a.order - b.order || a.tsMs - b.tsMs);
  return matched.slice(0, cap).map((m) => m.excerpt);
}
