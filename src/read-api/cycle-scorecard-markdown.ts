import type {
  CycleScorecard, RevisionAssessment, ScorecardAggregate, RosterEntry, TerminalKind,
} from '../domain/cycle-scorecard.ts';
import type { HoldoutValidation } from '../domain/strategy-revision.ts';
import type { PreservationMetadata } from '../validation/trade-preservation.ts';

// --- escaping helpers -------------------------------------------------------

// Wrap a value in a markdown inline-code span. A single-backtick span cannot
// contain a backtick, so when the value has one we widen the fence to a run one
// longer than the longest backtick-run inside, and pad with spaces (CommonMark
// strips one leading+trailing space pair inside a code span).
export function inlineCode(value: string): string {
  const s = String(value);
  if (!s.includes('`')) return `\`${s}\``;
  const runs = s.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${s} ${fence}`;
}

// Escape a value for a GFM table cell: backslashes first, then pipes (column
// delimiters) and newlines (row delimiters).
export function tableCell(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

// A table cell that renders a code token: wrap in a code span, then escape for
// the cell (GFM unescapes \| even inside code spans in tables).
function codeCell(value: string): string {
  return tableCell(inlineCode(value));
}

// --- number formatting ------------------------------------------------------

function fmt2(n: number): string {
  return n.toFixed(2);
}
function signedNum(n: number): string {
  const sign = n >= 0 ? '+' : '−'; // U+2212 MINUS SIGN
  const abs = Math.abs(n);
  return sign + (Number.isInteger(abs) ? String(abs) : abs.toFixed(2));
}

// --- sections ---------------------------------------------------------------

const TERMINAL_TITLES: Record<TerminalKind, string> = {
  accepted: '✅ Цикл завершён — ревизия принята',
  rejected: '❌ Цикл завершён — ревизия отклонена',
  skipped: '⏭️ Цикл завершён — слияние пропущено',
  abandoned: '⚠️ Цикл завершён — прерван до отбора',
};

function renderHeader(sc: CycleScorecard): string[] {
  return [
    `## ${TERMINAL_TITLES[sc.terminalOutcome.kind]}`,
    `**Причина:** ${inlineCode(sc.terminalOutcome.reason)} · **Профиль:** ${inlineCode(sc.strategyProfileId)}`,
  ];
}

// eligible and considered are rendered INDEPENDENTLY: either can be a real
// count or unavailable-with-its-own-reason. Never collapse one into the other.
function countOrUnavailable(v: number | null, reason?: string): string {
  if (v !== null) return `**${v}**`;
  return reason ? `_недоступно_ (${inlineCode(reason)})` : '_недоступно_';
}

function renderCounts(sc: CycleScorecard): string[] {
  const c = sc.counts;
  const out = ['### Отбор гипотез', `- Построено: **${c.built}** · Оценено: **${c.evaluated}**`];
  out.push(`- Допущено к отбору: ${countOrUnavailable(c.eligible, sc.eligibleUnavailableReason)}`);
  out.push(`- Рассмотрено: ${countOrUnavailable(c.considered, sc.consideredUnavailableReason)}`);
  out.push(c.eligible !== null
    ? `- Выбрано (champion): **${c.selected} из ${c.eligible}** · Отброшено: **${c.dropped}**`
    : `- Выбрано (champion): **${c.selected}** · Отброшено: **${c.dropped}**`);
  return out;
}

function renderAggregate(agg: ScorecardAggregate): string[] {
  const t = agg.thresholds;
  const out = [
    '#### Оценка отбора',
    '| Метрика | Baseline | Кандидат | Δ |',
    '|---|--:|--:|--:|',
    `| Net PnL, $ | ${fmt2(agg.baselineMetrics.netPnlUsd)} | ${fmt2(agg.candidateMetrics.netPnlUsd)} | ${signedNum(agg.deltas.netPnlUsd)} |`,
    `| Max drawdown, % | ${fmt2(agg.baselineMetrics.maxDrawdownPct)} | ${fmt2(agg.candidateMetrics.maxDrawdownPct)} | ${signedNum(agg.deltas.maxDrawdownPct)} |`,
    `| Сделок | ${agg.baselineMetrics.totalTrades} | ${agg.candidateMetrics.totalTrades} | ${signedNum(agg.deltas.totalTrades)} |`,
    '',
    `**Решение:** ${inlineCode(agg.decision)} · evaluator ${inlineCode(agg.evaluatorVersion)}`,
    `**Пороги:** minTrades ${t.minTrades} · minΔPnL $${t.minNetPnlImprovementUsd} · maxΔdrawdown ${t.maxDrawdownRegressionPct}% · topTrade ${t.topTradeContributionPct}%`,
  ];
  if (agg.reasons.length) {
    out.push(`**Причины:** ${agg.reasons.map(inlineCode).join('; ')}`);
  }
  return out;
}

function renderTradeSplit(ts: PreservationMetadata): string[] {
  const m = ts.metrics;
  const out = ['#### Сохранность сделок'];
  out.push(ts.fired ? `Вето: **сработало** (${inlineCode(ts.reason ?? 'unknown')})` : 'Вето: **не сработало**');
  out.push(`Совпало ${m.matchedCount} · исчезло ${m.disappearedCount} · новых ${m.newCount} · победителей baseline ${m.baselineWinnerCount}`);
  if (ts.fired) {
    const detail = [`totalΔ ${signedNum(m.totalDelta)}`];
    if (m.eodDelta !== undefined) detail.push(`eodΔ ${signedNum(m.eodDelta)}`);
    if (m.dropPct !== undefined) detail.push(`drop ${fmt2(m.dropPct)}%`);
    out.push(detail.join(' · '));
    const t = ts.thresholds;
    out.push(`Пороги: retention ${t.winnerRetention} · maxDrop ${t.maxTradeDropPct} · abstention ${t.abstentionShare} · eod ${t.eodShare}`);
  }
  return out;
}

function renderHoldout(h: HoldoutValidation): string[] {
  const out = ['#### Робастность (holdout)'];
  if (h.mode === 'none') {
    out.push(`Не проверялась (${inlineCode(h.reason)}).`);
    if (h.lowConfidence) out.push('⚠️ Низкая уверенность — оценка на малой выборке.');
    return out;
  }
  const parts = [`Режим ${inlineCode(h.mode)}`];
  if (h.t) parts.push(`граница ${inlineCode(h.t)}`);
  parts.push(h.holdoutDecision
    ? `вердикт ${inlineCode(h.holdoutDecision)} (${inlineCode(h.reason)})`
    : `(${inlineCode(h.reason)})`);
  out.push(parts.join(' · '));
  if (h.holdoutReasons && h.holdoutReasons.length) {
    out.push(`Причины holdout: ${h.holdoutReasons.map(inlineCode).join('; ')}`);
  }
  if (h.lowConfidence) out.push('⚠️ Низкая уверенность — оценка на малой выборке.');
  return out;
}

function renderAssessmentBody(ra: RevisionAssessment): string[] {
  const out: string[] = [];
  if (ra.aggregate) out.push('', ...renderAggregate(ra.aggregate));
  if (ra.tradeSplit) out.push('', ...renderTradeSplit(ra.tradeSplit));
  if (ra.robustness) out.push('', ...renderHoldout(ra.robustness));
  return out;
}

function renderChampion(ra: RevisionAssessment): string[] {
  return ['### 🏆 Champion', `Ревизия ${inlineCode(ra.revisionId)} (v${ra.version})`, ...renderAssessmentBody(ra)];
}

function renderRejectedRevision(ra: RevisionAssessment): string[] {
  return [
    '### Ревизия отклонена',
    `Ревизия ${inlineCode(ra.revisionId)} (v${ra.version}) — status ${inlineCode(ra.status)}`,
    ...renderAssessmentBody(ra),
  ];
}

function renderRoster(roster: readonly RosterEntry[]): string[] {
  if (!roster.length) return ['### Ростер гипотез', '_Гипотезы отсутствуют._'];
  const rows = roster.map((r) =>
    `| ${codeCell(r.hypId)} | ${r.lastDecision ? codeCell(r.lastDecision) : '—'} | ${codeCell(r.terminalStatus)} | ${r.considered ? '✓' : '—'} |`);
  return ['### Ростер гипотез', '| Гипотеза | Решение | Статус | Отбор |', '|---|---|---|---|', ...rows];
}

// --- top-level --------------------------------------------------------------

export function renderCycleScorecardMarkdown(sc: CycleScorecard): string {
  const lines: string[] = [];
  lines.push(...renderHeader(sc));
  lines.push('', ...renderCounts(sc));

  const ra = sc.revisionAssessment;
  if (sc.champion && ra) {
    lines.push('', ...renderChampion(ra));
  } else if (ra) {
    lines.push('', ...renderRejectedRevision(ra));
  } else if (!sc.provenance.mergeAttempted) {
    lines.push('', '_Слияние не выполнялось._');
  }

  lines.push('', ...renderRoster(sc.roster));
  lines.push('', '---', `_correlation ${inlineCode(sc.correlationId)} · schema ${inlineCode(sc.schemaVersion)}_`);
  return lines.join('\n') + '\n';
}
