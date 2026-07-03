// src/research/compose-revision-bundle.ts
//
// Pure codegen harness: assembles a revision's composed strategy module source from a base
// strategy factory + an already score-ordered, conflict-free list of hypothesis overlay module
// sources (spec: docs/superpowers/specs/2026-07-03-strategy-revisions-design.md §4, plan
// docs/superpowers/plans/2026-07-03-strategy-revisions.md Task 5). No I/O, no LLM — string
// templating + a fixed composer mirroring the backtester engine's veto/patch/annotate/pass
// semantics. Feed `output` to `assembleStrategyBundle` to get a real, executable bundle.
//
// MANDATORY INVESTIGATION FINDING (trading-backtester, one focused read):
//   - apps/backtester/src/engine/overlay.ts::OverlayComposer.compose walks overlays in fixed
//     input order, calling a caller-supplied `getDecision(overlay)` per overlay; on veto it
//     returns `{ finalDecision: null, effects }` immediately (terminal — later overlays are never
//     invoked); on patch it merges `{...accumulated, ...patch}` and re-validates against the
//     strategy-decision schema; on annotate/pass it just records an effect and continues.
//   - packages/sdk/src/contracts/authoring.ts::OverlayLifecycleModule requires exactly one hook,
//     `apply(ctx): OverlayDecision | readonly OverlayDecision[] | null` — the engine's own module
//     contract has NO branch for a data-only `{appliesTo, rules}` shape. module-executor.ts's
//     `executeOverlayApply` unconditionally calls `overlay.apply(ctx)`; there is no rule-string
//     interpreter anywhere in the engine (searched compile/normalize/rule-to-function helpers —
//     none exist). The "data-driven rules (preferred format)" section in
//     builder-sdk-doc.ts is therefore aspirational relative to the engine: even the *trusted*
//     execution path cannot run a Style-A module today. This CONFIRMS (does not merely assume)
//     the plan's fixed rule below — there is no deterministic interpreter to mirror, so
//     `unsupported_module_shape` is not a lab-side shortcut but the only correct behavior against
//     the real engine contract. No follow-up interpreter is warranted; if the engine ever grows
//     one, Style-A support should be added as a new slice mirroring that exact interpreter.
//   - LATENT GAP (documented, not implemented): the engine's `apply` may legally return a
//     `readonly OverlayDecision[]` (multiple decisions from one overlay), not just a single
//     `OverlayDecision | null`. The composer generated below (`buildComposedSource`) only handles
//     a single decision object per overlay call — `out.kind` is read directly off whatever `ov`
//     returns. If an overlay ever returns an array, `out.kind` is `undefined`, none of the
//     veto/patch/annotate branches match, and the array is silently treated as `pass` (decision
//     carried through unchanged) rather than raising an error or applying each decision in turn.
//     No overlay in this slice's fixtures returns an array, so this is a known gap, not a bug fix
//     target — a future slice composing array-returning overlays must add explicit handling here.
//
// STYLE DETECTION RULE (documented, deterministic, heuristic — not a parser):
//   `isFunctionalOverlaySource` strips `//` line comments and `/* */` block comments (naive —
//   does NOT special-case comment-like text inside string/template literals; acceptable because
//   overlay module sources are LLM/fixture-authored single-file modules with no such content in
//   practice) then tests for `export const overlay = <function-expression>` (named/anonymous
//   `function`, `async function`, or arrow form). Anything else — including the documented Style-A
//   `export const overlay = { appliesTo, rules }` object-literal shape, and any malformed/absent
//   `overlay` export — is treated as Style A / unsupported. This is a safe default: it never
//   silently miscomposes a non-functional module as if it were executable.
//
// CODEGEN TEMPLATE:
//   Each module (base + every composed overlay) is captured in its own IIFE so that internal
//   `const`/`let` names collide across modules without any renaming pass — namespace isolation is
//   structural (lexical scoping), not textual. The base's `export default function` is rewritten
//   to a bare `return function` (so the IIFE yields the factory itself, matching the verified
//   factory contract in fixtures/short-after-pump.strategy-source.ts: default-export a *factory*
//   that is called once to obtain `{ onBarClose(ctx) }`). Each overlay's
//   `export const overlay = <fn>` is rewritten to `return <fn>` the same way, so `__ov_i` is the
//   `apply` function itself, matching the composer's `ov(ctx, decision)` calls.
//
//   The composer only wraps `onBarClose` — the sole hook in scope for this slice's manifests
//   (`hooks: ['onBarClose']`, see fake-strategy-builder.ts's SHORT_AFTER_PUMP_META). Composing
//   other lifecycle hooks is out of scope until a base module declares more than one hook.
//
//   Ctx signature reconciliation (documented deviation, per plan): builder-sdk-doc.ts documents
//   `apply(ctx)` — single argument. The composer calls `ov(ctx, decision)` — two arguments — so
//   overlays written to the documented single-arg signature keep working (JS silently drops
//   unused trailing arguments) while overlays that *do* want the current decision can declare a
//   second parameter. No runtime arity check is performed beyond "it's a function" (already
//   guaranteed by the Style-B detection above) — there is nothing meaningful to gate on `ov.length`
//   at codegen time since arity is a property of the *compiled* function, not the source text.
import type { StrategyManifestMeta, StrategyBuilderOutput } from '../ports/strategy-builder.port.ts';
import type { RuleAction } from '../domain/hypothesis.ts';

export interface OverlayModuleInput {
  readonly hypothesisId: string;
  readonly source: string;
}

export interface UnsupportedOverlay {
  readonly hypothesisId: string;
  readonly detail: string;
}

export interface ComposeResult {
  readonly output: StrategyBuilderOutput;
  readonly included: string[];
  readonly unsupported: UnsupportedOverlay[];
  readonly mergedRuleSet: Record<string, unknown>;
}

export interface ComposeRevisionBundleArgs {
  readonly baseSource: string;
  readonly baseManifestMeta: StrategyManifestMeta;
  /** ALREADY score-ordered, conflicts removed (see hypothesis-score.ts / rule-conflict.ts). */
  readonly overlays: readonly OverlayModuleInput[];
  /** hypothesisId → ruleAction, for `mergedRuleSet.rules`. */
  readonly ruleActions: Record<string, RuleAction>;
  readonly revisionVersion: number;
  /**
   * Optional hypothesisId → thesis text, populated only when cheaply available to the caller.
   * When present, `mergedRuleSet.theses` carries the thesis for each *included* hypothesis (in
   * composed order), skipping ids with no thesis. Omitted entirely when no thesis is available
   * for any included id.
   *
   * Provenance (doc correction): this field is not part of Task 5's own brief/code-block — it
   * was added per plan docs/superpowers/plans/2026-07-03-strategy-revisions.md Task 10's note
   * ("carry the source hypothesis thesis inside mergedRuleSet entries if cheaply available —
   * store `{order, rules, theses?}` in Task 5's mergedRuleSet to keep this honest"). An earlier
   * write-up (task-5-report.md) mis-attributed this to a "Global Constraints" section — it is
   * not there; Task 10 is the correct citation.
   */
  readonly theses?: Record<string, string>;
}

const UNSUPPORTED_SHAPE_DETAIL = 'data-driven overlay (free-text when) cannot be deterministically composed lab-side';

/** Strip `//` and `/* *‍/` comments — naive, does not special-case string/template-literal content (see header). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Comment-MASKED but LENGTH-PRESERVING copy of `source`: every non-newline character inside a
 * `//` or `/* *‍/` comment is replaced with a space, everything else (including all offsets)
 * is untouched. Unlike `stripComments` (which shrinks the string and is only used for
 * classification), this is for LOCATING a rewrite target — a literal like
 * `export const overlay = function ...` quoted inside a comment (realistic: LLM-authored header
 * comments echo builder-sdk-doc.ts's own examples) no longer matches the pattern, while the
 * index of a real match still lines up 1:1 with `source` so the caller can splice the RAW text.
 */
function maskComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const FUNCTIONAL_OVERLAY_PATTERN =
  /export\s+const\s+overlay\s*=\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

function isFunctionalOverlaySource(source: string): boolean {
  return FUNCTIONAL_OVERLAY_PATTERN.test(stripComments(source));
}

/**
 * Find `pattern`'s first match on a comment-masked copy of `source` (so comment text can never
 * be mistaken for the real statement) and splice `replacement` over that span in the RAW
 * `source` (so real code — including any comments around it — is preserved byte-for-byte
 * outside the matched span). Returns `source` unchanged when there is no match.
 */
function rewriteFirstMatchOutsideComments(source: string, pattern: RegExp, replacement: string): string {
  const match = pattern.exec(maskComments(source));
  if (!match) return source;
  const start = match.index;
  const end = start + match[0].length;
  return source.slice(0, start) + replacement + source.slice(end);
}

const BASE_EXPORT_DEFAULT_FUNCTION = /export\s+default\s+function\b/;
function rewriteBaseSource(source: string): string {
  return rewriteFirstMatchOutsideComments(source, BASE_EXPORT_DEFAULT_FUNCTION, 'return function');
}

const OVERLAY_EXPORT_PREFIX = /export\s+const\s+overlay\s*=\s*/;
function rewriteOverlaySource(source: string): string {
  return rewriteFirstMatchOutsideComments(source, OVERLAY_EXPORT_PREFIX, 'return ');
}

function namespaceModule(varName: string, rewrittenSource: string): string {
  return `const ${varName} = (() => {\n${rewrittenSource}\n})();`;
}

function buildManifestMeta(
  base: StrategyManifestMeta,
  revisionVersion: number,
  includedIds: readonly string[],
): StrategyManifestMeta {
  const summarySuffix =
    includedIds.length > 0
      ? `Revision rev${revisionVersion} composing hypotheses: ${includedIds.join(', ')}.`
      : `Revision rev${revisionVersion} composing no hypotheses (all overlays unsupported).`;
  return {
    ...base,
    id: `${base.id}-rev${revisionVersion}`,
    // Same hooks/params/capabilities as base: overlay manifests aren't inputs to this harness
    // (only their entry source is), so there is nothing to union capabilities against. If a
    // future caller needs overlay-declared capabilities reflected here, it must pass them in
    // explicitly — this harness does not infer capabilities from overlay source text.
    summary: `${base.summary} ${summarySuffix}`,
  };
}

function buildComposedSource(baseSource: string, functionalOverlays: readonly OverlayModuleInput[]): string {
  const baseBlock = namespaceModule('__base', rewriteBaseSource(baseSource));
  const overlayBlocks = functionalOverlays
    .map((ov, i) => namespaceModule(`__ov_${i}`, rewriteOverlaySource(ov.source)))
    .join('\n\n');
  const overlayList = functionalOverlays.map((_, i) => `__ov_${i}`).join(', ');

  return `${baseBlock}

${overlayBlocks}

export default function createStrategyModule() {
  const base = __base();
  return {
    onBarClose(ctx) {
      let decision = base.onBarClose(ctx);
      for (const ov of [${overlayList}]) {
        const out = ov(ctx, decision);
        if (!out || out.kind === 'pass') continue;
        if (out.kind === 'annotate') {
          const note = [out.notes, ...(Array.isArray(out.tags) ? out.tags : [])].filter(Boolean).join('; ');
          if (note) {
            decision = { ...decision, rationale: decision.rationale ? \`\${decision.rationale} | \${note}\` : note };
          }
          continue;
        }
        if (out.kind === 'patch') {
          decision = { ...decision, ...out.patch };
          continue;
        }
        if (out.kind === 'veto') {
          decision = { kind: 'idle', rationale: out.reasonCode };
          break;
        }
      }
      return decision;
    },
  };
}
`;
}

/**
 * Deterministic, pure composition of a strategy revision's module source. Style-B (functional)
 * overlays are composed natively, in input order, into one namespace-isolated module; Style-A
 * (data-only) overlays are reported in `unsupported` and dropped from composition — never thrown.
 */
export function composeRevisionBundle(args: ComposeRevisionBundleArgs): ComposeResult {
  const included: string[] = [];
  const unsupported: UnsupportedOverlay[] = [];
  const functionalOverlays: OverlayModuleInput[] = [];

  for (const overlay of args.overlays) {
    if (isFunctionalOverlaySource(overlay.source)) {
      functionalOverlays.push(overlay);
      included.push(overlay.hypothesisId);
    } else {
      unsupported.push({ hypothesisId: overlay.hypothesisId, detail: UNSUPPORTED_SHAPE_DETAIL });
    }
  }

  const source = buildComposedSource(args.baseSource, functionalOverlays);
  const manifestMeta = buildManifestMeta(args.baseManifestMeta, args.revisionVersion, included);

  // Every `included` hypothesisId is expected to carry a structured ruleAction by construction
  // (caller contract — see ComposeRevisionBundleArgs.ruleActions doc). A missing entry means the
  // caller violated that contract; silently dropping it would desync `order`/`rules` and hide a
  // real bug, so this throws instead of filtering.
  const rules = included.map((id): RuleAction => {
    const rule = args.ruleActions[id];
    if (rule === undefined) {
      throw new Error(`ruleAction missing for hypothesis ${id}`);
    }
    return rule;
  });
  const thesesArray: (string | null)[] | undefined = args.theses
    ? included.map((id) => args.theses![id] ?? null)
    : undefined;
  // Keep theses only if at least one entry is non-null (preserve positional slots via null).
  const theses = thesesArray && thesesArray.some((t) => t !== null) ? thesesArray : undefined;

  const mergedRuleSet: Record<string, unknown> = {
    // Defensive copy: `included` is returned on ComposeResult too, and callers must not be able
    // to mutate mergedRuleSet.order by mutating result.included (or vice versa).
    order: [...included],
    rules,
    ...(theses ? { theses } : {}),
  };

  return {
    output: { source, manifestMeta },
    included,
    unsupported,
    mergedRuleSet,
  };
}
