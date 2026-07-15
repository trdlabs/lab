# R5c-lab — Cycle Scorecard Markdown Render (Lab side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Durable contract:** `docs/superpowers/specs/2026-07-15-r5c-lab-cycle-scorecard-markdown-spec.md` (R5d/Office references the spec, not this plan).

**Goal:** Render a closed-cycle `CycleScorecard` as human-readable Russian Markdown, serve it through the existing read-API cycle-scorecard route (`?format=markdown`) under the real `/v1` mount, and publish a stable, correctly-prefixed `scorecardUrl` link on the run-cycle completion summary.

**Architecture:** A pure presentation function `renderCycleScorecardMarkdown(sc: CycleScorecard): string` (imports only domain/port TYPES — safe under the read-API import-boundary guard). A single shared path-contract module (`paths.ts`) exports the Hono route template and derives the `/v1`-prefixed, `encodeURIComponent`-safe URL from that same template, so the route the app mounts and the link Office will fetch cannot drift. The `GET /cycles/:correlationId/scorecard` route gains a `?format=markdown` branch (text/markdown on 200 only; JSON 404 envelope untouched). The run-cycle completion summary gains an unconditional `links.scorecardUrl` — no read of the scorecard row from the summary path (the summary is emitted before the row exists, so an existence check would almost always be null and never self-heal).

**Tech Stack:** TypeScript on `node --experimental-strip-types`, Hono (read-API), Vitest (unit + inline/file snapshots). No new dependencies, no DB migration, no new env var, no LLM.

## Scope & Handoff (blocker 1 — resolved by splitting)

**This plan is Lab-side only (R5c-lab).** It delivers: the renderer, the `/v1` markdown endpoint, and the `scorecardUrl` link inside Lab's `research.run_cycle` completion summary. That is a complete, testable, shippable unit — one Lab PR.

**Out of scope → R5d (Office consumer, separate PR after a short retry-lifecycle design):** Office mirrors `LabSummaryLinks` by hand and drops unknown fields, reads only JSON, and `completionSummaryRender` does not handle `scorecardUrl`. Delivering the markdown *into the conversation* therefore requires Office work — DTO mirror gains `scorecardUrl`, an authenticated `text/markdown` fetch, the launch moment + bounded retry on 404 (the scorecard row lands after the summary), and rendering into the chat. That is R5d and depends on a retry-lifecycle design, not on this slice. Sequence: **Lab PR first, Office PR after.**

**R5d security invariant (carry into the Office design):** Office MUST treat `scorecardUrl` as a relative canonical `/v1/cycles/...` path only, and construct the fetch target by prepending its configured Lab base URL. It MUST NOT follow an arbitrary absolute URL taken from the DTO (an attacker-influenced absolute URL would let Office's authenticated read token be sent to an unintended host). Lab already emits a relative path (`cycleScorecardMarkdownUrl` returns `/v1/...`); the invariant makes the consumer side reject anything that isn't that shape.

## Global Constraints

- **No TS parameter properties** — `node --experimental-strip-types` breaks on `constructor(private x)`. An AST guard test enforces this. Write plain fields (this slice adds no classes).
- **Read-API import boundary** — files under `src/read-api/**` MUST NOT import concrete adapters/repositories. Importing domain/port/validation TYPES (`import type { ... }`) is allowed. Every new file here imports only `type` symbols (plus the local pure path/render modules).
- **Machine reasons verbatim** — every enum / machine reason string (`terminalOutcome.reason`, `RevisionDecision`, `HoldoutValidationReason`, `PreservationReason`, `EvaluationDecision`, `terminalStatus`, `eligibleUnavailableReason`, `consideredUnavailableReason`) is rendered verbatim inside backticks. A human-readable RU label MAY sit next to it, but the raw token must remain.
- **Language** — RU headings/labels; identifiers and enum tokens verbatim.
- **404 contract unchanged** — the route keeps returning `{ error: { code: 'not_found', ... } }` with status 404. Markdown is returned ONLY on a 200 (row found + `?format=markdown`).
- **`?format=markdown` only** — no `Accept`-header content negotiation in this slice.
- **URL is `/v1`-prefixed** — the read-API sub-app is mounted via `app.route('/v1', v1)`. Any URL that points at the scorecard MUST include `/v1`. Route template and URL-builder share one exported path contract.
- **Commands (repo scripts):** typecheck = `pnpm typecheck` (`tsc -p tsconfig.json`); tests = `pnpm test` (`vitest run`), single file = `pnpm test <path>`. `pnpm typecheck` covers `src/` only.

## Reference — exact types this plan depends on (do not redefine; import)

```typescript
// src/domain/cycle-scorecard.ts
export const CYCLE_SCORECARD_SCHEMA_VERSION = 'cycle-scorecard-v1';
export type TerminalKind = 'accepted' | 'rejected' | 'skipped' | 'abandoned';
export interface ScorecardCounts {
  built: number; evaluated: number;
  eligible: number | null; considered: number | null;
  selected: number; dropped: number;
}
export interface ScorecardAggregate {
  evaluatorVersion: string;
  baselineMetrics: BacktestMetricBlock; candidateMetrics: BacktestMetricBlock;
  deltas: { netPnlUsd: number; maxDrawdownPct: number; totalTrades: number };
  thresholds: RevisionEvaluatorPolicy;   // R5a persisted this for explainability — MUST be rendered
  decision: RevisionDecision;            // 'ACCEPT' | 'REJECT'
  reasons: string[];
}
export interface RevisionAssessment {
  revisionId: string; version: number;
  status: 'accepted' | 'rejected';
  aggregate: ScorecardAggregate | null;
  tradeSplit: PreservationMetadata | null;
  robustness: HoldoutValidation | null;
}
export interface RosterEntry {
  hypId: string; lastDecision: EvaluationDecision | null;
  terminalStatus: string; considered: boolean;
}
export interface CycleScorecard {
  schemaVersion: typeof CYCLE_SCORECARD_SCHEMA_VERSION;
  correlationId: string; strategyProfileId: string;
  terminalOutcome: { kind: TerminalKind; reason: string };
  counts: ScorecardCounts;
  eligibleUnavailableReason?: string; consideredUnavailableReason?: string;
  provenance: { mergeAttempted: boolean; candidateIncluded: number; revisionId?: string; sourceTaskId?: string };
  revisionAssessment: RevisionAssessment | null;
  champion: { revisionId: string; version: number } | null;
  selectionBias: { n: number | null; considered: number | null; selected: number };
  roster: RosterEntry[];
  verdict: { decision: string; reason: string };
}

// src/validation/revision-evaluator.ts
export type RevisionDecision = 'ACCEPT' | 'REJECT';
export interface RevisionEvaluatorPolicy {
  evaluatorVersion: string; minTrades: number; minNetPnlImprovementUsd: number;
  maxDrawdownRegressionPct: number; topTradeContributionPct: number;
}
export const DEFAULT_REVISION_EVALUATOR_POLICY: RevisionEvaluatorPolicy;

// src/ports/platform-gateway.port.ts
export interface BacktestMetricBlock {
  netPnlUsd: number; netPnlPct: number; totalTrades: number; winRate: number;
  profitFactor: number; maxDrawdownPct: number; expectancyUsd: number;
  sharpe: number; topTradeContributionPct: number;
}

// src/domain/strategy-revision.ts
export type HoldoutValidationReason =
  | 'skipped_insufficient_history' | 'skipped_insufficient_trades'
  | 'boundary_unavailable' | 'holdout_passed' | 'holdout_failed';
export interface HoldoutValidation {
  mode: 'none' | 'trade_based'; t?: string; reason: HoldoutValidationReason; lowConfidence?: boolean;
  trainMetrics?: Record<string, unknown>; holdoutMetrics?: Record<string, unknown>;
  trainBaselineMetrics?: BacktestMetricBlock; holdoutBaselineMetrics?: BacktestMetricBlock;
  holdoutDecision?: RevisionDecision; holdoutReasons?: string[]; policy?: RevisionEvaluatorPolicy;
}

// src/validation/trade-preservation.ts
export type PreservationReason = 'end_of_data_position' | 'abstention_gaming' | 'winner_degradation';
export interface PreservationThresholds {
  winnerRetention: number; maxTradeDropPct: number; abstentionShare: number;
  eodShare: number; matchToleranceMs: number; minWinnerSample: number;
}
export interface PreservationMetadata {
  fired: boolean; reason: PreservationReason | null;
  metrics: {
    totalDelta: number; matchedCount: number; disappearedCount: number; newCount: number; baselineWinnerCount: number;
    eodDelta?: number; dropPct?: number; removedLosersPnl?: number; baselineWinnerGross?: number; variantWinnerContribution?: number;
  };
  thresholds: PreservationThresholds;
}

// src/read-api/deps.ts — deps.cycleScorecards: CycleScorecardRepository
// src/ports/cycle-scorecard.repository.ts — CycleScorecardRow.payload: CycleScorecard (already typed; no cast)
// src/domain/types.ts — ResearchTask.correlationId is a required top-level string.
// src/read-api/read-app.ts — app.route('/v1', v1); V1_PATHS contains '/cycles/:correlationId/scorecard'.
```

---

### Task 1: Markdown escaping helpers + pure renderer

**Files:**
- Create: `src/read-api/cycle-scorecard-markdown.ts`
- Test: `src/read-api/cycle-scorecard-markdown.test.ts`

**Interfaces:**
- Consumes: `CycleScorecard`, `RevisionAssessment`, `ScorecardAggregate`, `RosterEntry`, `TerminalKind` (from `../domain/cycle-scorecard.ts`); `HoldoutValidation` (from `../domain/strategy-revision.ts`); `PreservationMetadata` (from `../validation/trade-preservation.ts`).
- Produces: `renderCycleScorecardMarkdown(sc: CycleScorecard): string`, plus exported `inlineCode(value: string): string` and `tableCell(value: string): string`.

- [ ] **Step 1: Write failing tests for the escaping helpers**

Create `src/read-api/cycle-scorecard-markdown.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { inlineCode, tableCell } from './cycle-scorecard-markdown.ts';

describe('inlineCode', () => {
  it('wraps a plain value in single backticks', () => {
    expect(inlineCode('rev-1')).toBe('`rev-1`');
  });
  it('widens the fence and pads when the value contains a backtick', () => {
    expect(inlineCode('a`b')).toBe('`` a`b ``');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/read-api/cycle-scorecard-markdown.test.ts`
Expected: FAIL — cannot resolve `./cycle-scorecard-markdown.ts`.

- [ ] **Step 3: Implement the helpers and the full renderer**

Create `src/read-api/cycle-scorecard-markdown.ts`:

```typescript
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
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `pnpm test src/read-api/cycle-scorecard-markdown.test.ts`
Expected: PASS (the 4 helper tests). Renderer now defined.

- [ ] **Step 5: Add renderer fixtures + state/snapshot/escaping tests**

Append to `src/read-api/cycle-scorecard-markdown.test.ts`:

```typescript
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
```

- [ ] **Step 6: Run the full renderer test file; review and accept the snapshot**

Run: `pnpm test src/read-api/cycle-scorecard-markdown.test.ts`
Expected: PASS. Golden snapshot written to `src/read-api/__snapshots__/cycle-scorecard-markdown.test.ts.snap`. **Read the generated snapshot** and confirm the accepted-state markdown matches the approved layout (header → counts with independent eligible/considered + "1 из 3" → 🏆 Champion → aggregate table + **Пороги** → trade-split → holdout → roster → footer). If wrong, fix the renderer (not the snapshot).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/read-api/cycle-scorecard-markdown.ts src/read-api/cycle-scorecard-markdown.test.ts src/read-api/__snapshots__/cycle-scorecard-markdown.test.ts.snap
git commit -m "feat(r5c-lab): pure CycleScorecard -> Russian Markdown renderer with escaping"
```

---

### Task 2: Shared `/v1` path contract + `?format=markdown` route branch

**Files:**
- Create: `src/read-api/paths.ts`
- Modify: `src/read-api/routes/cycle-scorecard.ts`; `src/read-api/read-app.ts` (`V1_PATHS` list + `app.route('/v1', v1)`)
- Test: `src/read-api/paths.test.ts`; `src/read-api/routes/cycle-scorecard.test.ts`

**Interfaces:**
- Consumes: `renderCycleScorecardMarkdown` (Task 1); `ReadApiDeps`; `CYCLE_SCORECARD_SCHEMA_VERSION`.
- Produces: `CYCLE_SCORECARD_ROUTE: string`, `READ_API_V1_PREFIX: string`, `cycleScorecardMarkdownUrl(correlationId: string): string` (from `./paths.ts`). Route registered via `app.get(CYCLE_SCORECARD_ROUTE, ...)`; `?format=markdown` returns `200 text/markdown; charset=utf-8`.

- [ ] **Step 1: Write failing tests for the path contract**

Create `src/read-api/paths.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { cycleScorecardMarkdownUrl, CYCLE_SCORECARD_ROUTE, READ_API_V1_PREFIX } from './paths.ts';

describe('cycleScorecardMarkdownUrl', () => {
  it('builds the /v1-prefixed markdown path from the shared route template', () => {
    expect(cycleScorecardMarkdownUrl('c-1')).toBe('/v1/cycles/c-1/scorecard?format=markdown');
  });
  it('percent-encodes the correlationId', () => {
    expect(cycleScorecardMarkdownUrl('a/b c')).toBe('/v1/cycles/a%2Fb%20c/scorecard?format=markdown');
  });
  it('exposes the constants the app mounts', () => {
    expect(READ_API_V1_PREFIX).toBe('/v1');
    expect(CYCLE_SCORECARD_ROUTE).toBe('/cycles/:correlationId/scorecard');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/read-api/paths.test.ts`
Expected: FAIL — module `./paths.ts` does not exist.

- [ ] **Step 3: Implement the path contract**

Create `src/read-api/paths.ts` (shared read-API path contract — NOT owned by the scorecard feature; the whole read surface mounts through `READ_API_V1_PREFIX`):

```typescript
// Shared read-API path contract. READ_API_V1_PREFIX is the mount prefix for the
// entire /v1 read surface (app.route(READ_API_V1_PREFIX, v1) in read-app.ts) —
// it deliberately lives here, not in any feature module, so the app does not
// depend back on a single feature. CYCLE_SCORECARD_ROUTE is registered relative
// to that sub-app; cycleScorecardMarkdownUrl re-materializes the SAME template
// with the /v1 prefix so an external consumer (Office, R5d) fetches exactly what
// the app serves — route template and URL derived from one string, no drift.
export const READ_API_V1_PREFIX = '/v1';
export const CYCLE_SCORECARD_ROUTE = '/cycles/:correlationId/scorecard';

export function cycleScorecardMarkdownUrl(correlationId: string): string {
  const path = CYCLE_SCORECARD_ROUTE.replace(':correlationId', encodeURIComponent(correlationId));
  return `${READ_API_V1_PREFIX}${path}?format=markdown`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/read-api/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for the markdown route branch**

Add to `src/read-api/routes/cycle-scorecard.test.ts` — reuse its existing `deps`, `makeCycleScorecards`, `scorecard`, `auth`, and `CycleScorecardRow` shape. Add the import at the top:

```typescript
import { cycleScorecardMarkdownUrl } from '../paths.ts';
```

Then add inside the `describe('GET /v1/cycles/:correlationId/scorecard', ...)` block:

```typescript
  function rowFor(sc = scorecard()): CycleScorecardRow {
    return {
      id: 'row-1', correlationId: sc.correlationId, strategyProfileId: sc.strategyProfileId,
      schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION, payload: sc,
      generatedAt: '2026-07-14T00:00:00.000Z', createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:00:00.000Z',
    };
  }

  it('?format=markdown returns text/markdown on 200', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards([rowFor()]) }));
    const res = await app.request('/v1/cycles/c1/scorecard?format=markdown', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect((await res.text()).startsWith('## ')).toBe(true);
  });

  it('?format=markdown on a missing row keeps the JSON 404 envelope', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards() }));
    const res = await app.request('/v1/cycles/unknown/scorecard?format=markdown', auth);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('default (no format) still returns JSON payload', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards([rowFor()]) }));
    const res = await app.request('/v1/cycles/c1/scorecard', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('the URL builder path resolves to the same 200 markdown route the app serves (centralization is real)', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards([rowFor()]) }));
    const res = await app.request(cycleScorecardMarkdownUrl('c1'), auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
  });
```

- [ ] **Step 6: Run to verify the new route tests fail**

Run: `pnpm test src/read-api/routes/cycle-scorecard.test.ts`
Expected: FAIL — markdown request currently returns `application/json` (branch not implemented).

- [ ] **Step 7: Add the markdown branch and adopt the shared route constant**

Rewrite `src/read-api/routes/cycle-scorecard.ts`:

```typescript
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../../domain/cycle-scorecard.ts';
import { renderCycleScorecardMarkdown } from '../cycle-scorecard-markdown.ts';
import { CYCLE_SCORECARD_ROUTE } from '../paths.ts';

export function registerCycleScorecardRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get(CYCLE_SCORECARD_ROUTE, async (c) => {
    const row = await deps.cycleScorecards.findByCorrelationAndSchema(
      c.req.param('correlationId'), CYCLE_SCORECARD_SCHEMA_VERSION,
    );
    if (!row) {
      return c.json({ error: { code: 'not_found', message: 'cycle scorecard not available' } }, 404);
    }
    if (c.req.query('format') === 'markdown') {
      return c.body(renderCycleScorecardMarkdown(row.payload), 200, {
        'content-type': 'text/markdown; charset=utf-8',
      });
    }
    return c.json(row.payload);
  });
}
```

- [ ] **Step 8: Route `V1_PATHS` and the mount through the shared constants**

Edit `src/read-api/read-app.ts`:

1. Add the import alongside the other route imports:

```typescript
import { CYCLE_SCORECARD_ROUTE, READ_API_V1_PREFIX } from './paths.ts';
```

2. In the `V1_PATHS` array, replace the literal `'/cycles/:correlationId/scorecard'` with `CYCLE_SCORECARD_ROUTE` (value-identical; keeps the 405 loop in sync with the route).

3. Change the mount line from `app.route('/v1', v1);` to:

```typescript
  app.route(READ_API_V1_PREFIX, v1);
```

- [ ] **Step 9: Run the route + path tests to verify they pass**

Run: `pnpm test src/read-api/routes/cycle-scorecard.test.ts src/read-api/paths.test.ts`
Expected: PASS — markdown 200, JSON 404 preserved, JSON default preserved, 401/405 unchanged, builder URL resolves to the served route.

- [ ] **Step 10: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/read-api/paths.ts src/read-api/paths.test.ts src/read-api/routes/cycle-scorecard.ts src/read-api/routes/cycle-scorecard.test.ts src/read-api/read-app.ts
git commit -m "feat(r5c-lab): serve scorecard markdown at a shared /v1 path contract"
```

---

### Task 3: `links.scorecardUrl` on the run-cycle completion summary

**Files:**
- Modify: `src/read-api/completion-summary.ts` (`SummaryLinks` interface at :26; `buildRunCycle` return at :148)
- Test: the read-api test that already covers `buildRunCycle` (search the read-api tests for `research.run_cycle`; extend that file)

**Interfaces:**
- Consumes: `cycleScorecardMarkdownUrl` (Task 2); `ResearchTask.correlationId` (required top-level string).
- Produces: `SummaryLinks.scorecardUrl?: string`; `buildRunCycle` sets `links.scorecardUrl` unconditionally from `task.correlationId`.

- [ ] **Step 1: Write the failing test for `links.scorecardUrl`**

Find the existing `buildRunCycle` / `research.run_cycle` completion-summary test. Add (reuse the file's existing task + deps construction; set the task's `correlationId` to `'corr-9'`):

```typescript
it('attaches a stable /v1 scorecardUrl built from the task correlationId (no scorecard read required)', async () => {
  // Build a research.run_cycle ResearchTask with correlationId 'corr-9' the way the
  // surrounding tests do, then call buildCompletionSummary. Do NOT seed a scorecard row —
  // the link must not depend on the row existing.
  const summary = await buildCompletionSummary(deps, task.id);
  if (summary.kind !== 'research.run_cycle') throw new Error('expected run_cycle summary');
  expect(summary.links.scorecardUrl).toBe('/v1/cycles/corr-9/scorecard?format=markdown');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test <that completion-summary test file>`
Expected: FAIL — `summary.links.scorecardUrl` is `undefined` (and a TS error that `scorecardUrl` is not on `SummaryLinks`).

- [ ] **Step 3: Add the field and emit it**

Edit `src/read-api/completion-summary.ts`:

1. Add the import near the top:

```typescript
import { cycleScorecardMarkdownUrl } from './paths.ts';
```

2. Extend `SummaryLinks` (line 26):

```typescript
export interface SummaryLinks { taskId: string; profileId?: string; hypothesisId?: string; backtestRunId?: string; scorecardUrl?: string }
```

3. In `buildRunCycle`, change the returned `links` to add `scorecardUrl` unconditionally:

```typescript
    links: { taskId: task.id, profileId, scorecardUrl: cycleScorecardMarkdownUrl(task.correlationId) },
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test <that completion-summary test file>`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/read-api/completion-summary.ts <that completion-summary test file>
git commit -m "feat(r5c-lab): publish stable /v1 scorecardUrl on run-cycle completion summary"
```

---

### Task 4: Full-suite regression + read-boundary guard

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

Run: `pnpm test`
Expected: PASS — entire suite green (baseline 3672/0 at #177). The read-API import-boundary guard is part of the suite; confirm it stays green (the new `src/read-api/**` files import only `type` symbols plus the local pure path/render modules). No snapshot obsoletions reported.

- [ ] **Step 2: Typecheck the whole project**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 3: No commit** (verification only). If any step fails, return to the owning task, fix, and re-run.

---

## Self-Review

**Spec coverage:**
- Pure `CycleScorecard → Markdown` — Task 1. ✅
- Output surfaced Lab-side (link on summary + `/v1` endpoint) — Tasks 2 & 3; Office consumption explicitly deferred to R5d (Scope & Handoff). ✅ (blocker 1)
- Correct states champion/no-champion/skipped/abandoned — Task 1 Step 5 covers all four. ✅
- "выбран из N", aggregate/trade-split/holdout, low-confidence — `renderCounts` ("N"), `renderAggregate` (incl. **Пороги**), `renderTradeSplit`, `renderHoldout` + lowConfidence marker. ✅
- Snapshot tests, no LLM/migration/env — Task 1 golden snapshot; nothing touches DB/env/LLM. ✅
- `/v1`-prefixed URL from a shared exported path contract + real-route e2e test — Task 2. ✅ (blocker 2)
- Aggregate thresholds rendered + valid policy fixture (no `{} as never`) — `renderAggregate` + `policy` const. ✅ (important)
- eligible & considered independent, each with its own unavailable reason — `countOrUnavailable` + dedicated test. ✅ (important)
- roster `lastDecision` & `terminalStatus` via `codeCell` (verbatim in backticks) — `renderRoster` + escaping test. ✅ (important)
- `pnpm typecheck` / `pnpm test` commands throughout. ✅ (important)
- 404 keeps JSON envelope; markdown only on 200; `?format=markdown` only (no Accept) — Task 2. ✅
- Machine reasons verbatim in backticks — `inlineCode`/`codeCell` for every reason/enum; escaping test asserts it. ✅
- `inlineCode()` + `tableCell()` escaping helpers + escaping test — Task 1. ✅

**Type consistency:** `renderCycleScorecardMarkdown`, `inlineCode`, `tableCell`, `cycleScorecardMarkdownUrl`, `CYCLE_SCORECARD_ROUTE`, `READ_API_V1_PREFIX` used with identical names/signatures across tasks. `row.payload` is typed `CycleScorecard` (no cast). `SummaryLinks.scorecardUrl?: string` matches `cycleScorecardMarkdownUrl`'s return. `RevisionEvaluatorPolicy` fields (`minTrades`, `minNetPnlImprovementUsd`, `maxDrawdownRegressionPct`, `topTradeContributionPct`) match `renderAggregate` and the `policy` fixture.

**Placeholder scan:** no TBD/TODO; all code steps carry complete code. Task 3's test references the file's existing `research.run_cycle` task/deps construction rather than duplicating unknown harness wiring — deliberate reuse, with the exact assertion named. `<that completion-summary test file>` is resolved by a one-line grep at execution start (`research.run_cycle` in the read-api tests).
