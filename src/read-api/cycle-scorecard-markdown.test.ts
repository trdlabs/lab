import { describe, it, expect } from 'vitest';
import { inlineCode, tableCell } from './cycle-scorecard-markdown.ts';

describe('inlineCode', () => {
  it('wraps a plain value in single backticks', () => {
    expect(inlineCode('rev-1')).toBe('`rev-1`');
  });
  it('widens the fence and pads when the value contains a backtick', () => {
    expect(inlineCode('a`b')).toBe('`` a`b ``');
  });
  it('collapses newlines so a prose value cannot break out of the code span', () => {
    expect(inlineCode('a\n\n## evil')).toBe('`a  ## evil`');
  });
});

describe('tableCell', () => {
  it('escapes pipes and collapses newlines so a cell cannot break the table', () => {
    expect(tableCell('a|b\nc')).toBe('a\\|b c');
  });
  it('escapes backslashes before pipes', () => {
    expect(tableCell('a\\b')).toBe('a\\\\b');
  });
});

import { renderCycleScorecardMarkdown } from './cycle-scorecard-markdown.ts';
import type { CycleScorecard } from '../domain/cycle-scorecard.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { RevisionEvaluatorPolicy } from '../validation/revision-evaluator.ts';

const policy: RevisionEvaluatorPolicy = {
  evaluatorVersion: 'rev-eval-v1', minTrades: 20, minNetPnlImprovementUsd: 5,
  maxDrawdownRegressionPct: 2, topTradeContributionPct: 40,
};

function metrics(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return {
    netPnlUsd: 100, netPnlPct: 10, totalTrades: 40, winRate: 0.6, profitFactor: 1.5,
    maxDrawdownPct: 8, expectancyUsd: 2.5, sharpe: 1.2, topTradeContributionPct: 20, ...over,
  };
}

function base(over: Partial<CycleScorecard> = {}): CycleScorecard {
  return {
    schemaVersion: 'cycle-scorecard-v1',
    correlationId: 'c-1', strategyProfileId: 'p1',
    terminalOutcome: { kind: 'skipped', reason: 'no_baseline' },
    counts: { built: 2, evaluated: 1, eligible: null, considered: null, selected: 0, dropped: 0 },
    provenance: { mergeAttempted: false, candidateIncluded: 0 },
    revisionAssessment: null,
    champion: null,
    selectionBias: { n: null, considered: null, selected: 0 },
    roster: [{ hypId: 'h1', lastDecision: 'FAIL', terminalStatus: 'rejected', considered: false }],
    verdict: { decision: 'skipped', reason: 'no_baseline' },
    ...over,
  };
}

const acceptedScorecard: CycleScorecard = base({
  terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
  counts: { built: 3, evaluated: 3, eligible: 3, considered: 3, selected: 1, dropped: 2 },
  provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r1' },
  champion: { revisionId: 'r1', version: 2 },
  selectionBias: { n: 3, considered: 3, selected: 1 },
  revisionAssessment: {
    revisionId: 'r1', version: 2, status: 'accepted',
    aggregate: {
      evaluatorVersion: 'rev-eval-v1',
      baselineMetrics: metrics(), candidateMetrics: metrics({ netPnlUsd: 112.5, maxDrawdownPct: 7.2, totalTrades: 42 }),
      deltas: { netPnlUsd: 12.5, maxDrawdownPct: -0.8, totalTrades: 2 },
      thresholds: policy, decision: 'ACCEPT', reasons: ['net_pnl_improved', 'drawdown_within_tolerance'],
    },
    tradeSplit: {
      fired: false, reason: null,
      metrics: { totalDelta: 2, matchedCount: 38, disappearedCount: 1, newCount: 4, baselineWinnerCount: 12 },
      thresholds: { winnerRetention: 0.9, maxTradeDropPct: 0.2, abstentionShare: 0.3, eodShare: 0.3, matchToleranceMs: 1000, minWinnerSample: 5 },
    },
    robustness: { mode: 'trade_based', t: '2026-06-15T00:00:00Z', reason: 'holdout_passed', holdoutDecision: 'ACCEPT' },
  },
  roster: [
    { hypId: 'h1', lastDecision: 'PASS', terminalStatus: 'merged', considered: true },
    { hypId: 'h2', lastDecision: 'PASS', terminalStatus: 'merged', considered: true },
    { hypId: 'h3', lastDecision: 'FAIL', terminalStatus: 'rejected', considered: false },
  ],
});

describe('renderCycleScorecardMarkdown — states', () => {
  it('accepted (champion) — golden snapshot', () => {
    expect(renderCycleScorecardMarkdown(acceptedScorecard)).toMatchSnapshot();
  });

  it('accepted — champion, "выбран из N", aggregate table, and thresholds', () => {
    const md = renderCycleScorecardMarkdown(acceptedScorecard);
    expect(md).toContain('## ✅ Цикл завершён — ревизия принята');
    expect(md).toContain('### 🏆 Champion');
    expect(md).toContain('- Допущено к отбору: **3**');
    expect(md).toContain('- Рассмотрено: **3**');
    expect(md).toContain('Выбрано (champion): **1 из 3**');
    expect(md).toContain('| Net PnL, $ | 100.00 | 112.50 | +12.50 |');
    expect(md).toContain('| Max drawdown, % | 8.00 | 7.20 | −0.80 |');
    expect(md).toContain('| Сделок | 40 | 42 | +2 |');
    expect(md).toContain('**Решение:** `ACCEPT`');
    expect(md).toContain('**Пороги:** minTrades 20 · minΔPnL $5 · maxΔdrawdown 2% · topTrade 40%');
  });

  it('rejected — no champion, shows rejected revision + REJECT decision', () => {
    const md = renderCycleScorecardMarkdown(base({
      terminalOutcome: { kind: 'rejected', reason: 'pnl_regressed' },
      counts: { built: 2, evaluated: 2, eligible: 2, considered: 2, selected: 0, dropped: 2 },
      provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r9' },
      revisionAssessment: {
        revisionId: 'r9', version: 1, status: 'rejected',
        aggregate: {
          evaluatorVersion: 'rev-eval-v1',
          baselineMetrics: metrics(), candidateMetrics: metrics({ netPnlUsd: 80 }),
          deltas: { netPnlUsd: -20, maxDrawdownPct: 0, totalTrades: 0 },
          thresholds: policy, decision: 'REJECT', reasons: ['net_pnl_regressed'],
        },
        tradeSplit: null, robustness: null,
      },
    }));
    expect(md).toContain('## ❌ Цикл завершён — ревизия отклонена');
    expect(md).toContain('### Ревизия отклонена');
    expect(md).not.toContain('### 🏆 Champion');
    expect(md).toContain('status `rejected`');
    expect(md).toContain('**Решение:** `REJECT`');
  });

  it('skipped — "Слияние не выполнялось", eligible недоступно, still lists roster', () => {
    const md = renderCycleScorecardMarkdown(base({ eligibleUnavailableReason: 'terminated_before_selection' }));
    expect(md).toContain('## ⏭️ Цикл завершён — слияние пропущено');
    expect(md).toContain('_Слияние не выполнялось._');
    expect(md).toContain('- Допущено к отбору: _недоступно_ (`terminated_before_selection`)');
    expect(md).toContain('### Ростер гипотез');
  });

  it('abandoned — before selection, null-eligible, empty roster', () => {
    const md = renderCycleScorecardMarkdown(base({
      terminalOutcome: { kind: 'abandoned', reason: 'budget_exhausted' },
      counts: { built: 1, evaluated: 0, eligible: null, considered: null, selected: 0, dropped: 0 },
      roster: [],
    }));
    expect(md).toContain('## ⚠️ Цикл завершён — прерван до отбора');
    expect(md).toContain('- Допущено к отбору: _недоступно_');
    expect(md).toContain('_Гипотезы отсутствуют._');
  });

  it('unknown terminal kind falls back to a generic heading instead of rendering "undefined"', () => {
    const md = renderCycleScorecardMarkdown(base({
      terminalOutcome: {
        kind: 'drifted_unknown_kind' as CycleScorecard['terminalOutcome']['kind'],
        reason: 'schema_drift',
      },
    }));
    expect(md).toContain('## Цикл завершён');
    expect(md).not.toContain('## undefined');
  });

  it('eligible UNAVAILABLE + considered AVAILABLE render independently (reverse of the case above)', () => {
    const md = renderCycleScorecardMarkdown(base({
      counts: { built: 3, evaluated: 3, eligible: null, considered: 2, selected: 0, dropped: 0 },
      eligibleUnavailableReason: 'eligibility_check_skipped',
    }));
    expect(md).toContain('- Допущено к отбору: _недоступно_ (`eligibility_check_skipped`)');
    expect(md).toContain('- Рассмотрено: **2**');
  });

  it('eligible and considered render independently, each with its own unavailable reason', () => {
    const md = renderCycleScorecardMarkdown(base({
      counts: { built: 3, evaluated: 3, eligible: 3, considered: null, selected: 1, dropped: 1 },
      consideredUnavailableReason: 'selection_short_circuited',
      champion: { revisionId: 'r1', version: 1 },
      provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r1' },
      revisionAssessment: { revisionId: 'r1', version: 1, status: 'accepted', aggregate: null, tradeSplit: null, robustness: null },
    }));
    expect(md).toContain('- Допущено к отбору: **3**');
    expect(md).toContain('- Рассмотрено: _недоступно_ (`selection_short_circuited`)');
  });

  it('holdout mode:none — "не проверялась" with verbatim reason', () => {
    const md = renderCycleScorecardMarkdown(base({
      champion: { revisionId: 'r1', version: 1 },
      counts: { built: 1, evaluated: 1, eligible: 1, considered: 1, selected: 1, dropped: 0 },
      provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r1' },
      revisionAssessment: {
        revisionId: 'r1', version: 1, status: 'accepted', aggregate: null, tradeSplit: null,
        robustness: { mode: 'none', reason: 'skipped_insufficient_trades' },
      },
    }));
    expect(md).toContain('Не проверялась (`skipped_insufficient_trades`).');
  });

  it('holdout lowConfidence — surfaces the ⚠️ marker and holdoutReasons', () => {
    const md = renderCycleScorecardMarkdown(base({
      champion: { revisionId: 'r1', version: 1 },
      counts: { built: 1, evaluated: 1, eligible: 1, considered: 1, selected: 1, dropped: 0 },
      provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r1' },
      revisionAssessment: {
        revisionId: 'r1', version: 1, status: 'accepted', aggregate: null, tradeSplit: null,
        robustness: {
          mode: 'trade_based', t: '2026-06-15T00:00:00Z', reason: 'holdout_passed',
          holdoutDecision: 'ACCEPT', holdoutReasons: ['small_sample'], lowConfidence: true,
        },
      },
    }));
    expect(md).toContain('Причины holdout: `small_sample`');
    expect(md).toContain('⚠️ Низкая уверенность — оценка на малой выборке.');
  });

  it('trade-split fired — shows reason, deltas, and thresholds; optional metrics only when present', () => {
    const md = renderCycleScorecardMarkdown(base({
      champion: { revisionId: 'r1', version: 1 },
      counts: { built: 1, evaluated: 1, eligible: 1, considered: 1, selected: 1, dropped: 0 },
      provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r1' },
      revisionAssessment: {
        revisionId: 'r1', version: 1, status: 'accepted', aggregate: null, robustness: null,
        tradeSplit: {
          fired: true, reason: 'winner_degradation',
          metrics: { totalDelta: -3, matchedCount: 30, disappearedCount: 5, newCount: 2, baselineWinnerCount: 10, eodDelta: -1, dropPct: 12.5 },
          thresholds: { winnerRetention: 0.9, maxTradeDropPct: 0.2, abstentionShare: 0.3, eodShare: 0.3, matchToleranceMs: 1000, minWinnerSample: 5 },
        },
      },
    }));
    expect(md).toContain('Вето: **сработало** (`winner_degradation`)');
    expect(md).toContain('totalΔ −3 · eodΔ −1 · drop 12.50%');
    expect(md).toContain('Пороги: retention 0.9 · maxDrop 0.2 · abstention 0.3 · eod 0.3');
  });

  it('escapes pipes / backticks / newlines in ids, reasons, and table values', () => {
    const md = renderCycleScorecardMarkdown(base({
      correlationId: 'c|1',
      terminalOutcome: { kind: 'skipped', reason: 'weird`reason' },
      roster: [{ hypId: 'h|1', lastDecision: null, terminalStatus: 'a|b', considered: false }],
    }));
    expect(md).toContain('**Причина:** `` weird`reason ``');       // widened, padded fence
    expect(md).toContain('_correlation `c|1`');                    // prose code span keeps literal pipe
    expect(md).toContain('| `h\\|1` | — | `a\\|b` | — |');         // table cells escape pipes; null decision -> —
  });
});
