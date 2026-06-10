// src/validation/hypothesis-validator.ts
import type { HypothesisProposalDraft } from '../domain/hypothesis.ts';
import type { ValidationIssue } from '../domain/schemas.ts';
import {
  OVERLAY_ACTIONS, normalizeFeature,
  LIVE_INTENT_DENYLIST, LOOKAHEAD_DENYLIST, AUTHORITY_DENYLIST, PARAM_DENYLIST,
} from '../domain/hypothesis-rules.ts';

export interface HypothesisValidation {
  status: 'validated' | 'rejected';
  issues: ValidationIssue[];
  normalizedFeatures: string[];
}

/** Locale-independent total order, so the gate is deterministic across environments. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const OVERLAY_ACTION_SET = new Set<string>(OVERLAY_ACTIONS);

/** Mandatory accept/reject gate. Runs AFTER the schema gate. Dedupe is NOT checked here —
 *  the handler owns exact-fingerprint dedupe so this stays a pure function. */
export function validateHypothesis(
  draft: HypothesisProposalDraft,
  ctx: { allowedFeatures: Set<string> },
): HypothesisValidation {
  const issues: ValidationIssue[] = [];
  const normalizedFeatures = draft.requiredFeatures.map(normalizeFeature);

  if (draft.invalidationCriteria.length === 0) {
    issues.push({ code: 'missing_falsifiability', severity: 'error', path: 'invalidationCriteria', message: 'invalidationCriteria must not be empty' });
  }

  draft.ruleAction.rules.forEach((rule, i) => {
    if (!OVERLAY_ACTION_SET.has(rule.action)) {
      issues.push({ code: 'disallowed_action', severity: 'error', path: `ruleAction.rules.${i}.action`, message: `action '${rule.action}' is not allowed` });
    }
    for (const [key, value] of Object.entries(rule.params)) {
      const lowerKey = key.toLowerCase();
      if (PARAM_DENYLIST.some((t) => lowerKey.includes(t))) {
        issues.push({ code: 'action_param_violation', severity: 'error', path: `ruleAction.rules.${i}.params.${key}`, message: `param key '${key}' carries disallowed live/order semantics` });
      }
      if (typeof value === 'string') {
        const lowerVal = value.toLowerCase();
        if (PARAM_DENYLIST.some((t) => lowerVal.includes(t))) {
          issues.push({ code: 'action_param_violation', severity: 'error', path: `ruleAction.rules.${i}.params.${key}`, message: 'param value carries disallowed live/order semantics' });
        }
      } else if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') {
        issues.push({ code: 'action_param_violation', severity: 'error', path: `ruleAction.rules.${i}.params.${key}`, message: 'param value must be a primitive (string/number/boolean/null)' });
      }
    }
  });

  normalizedFeatures.forEach((f, i) => {
    if (!ctx.allowedFeatures.has(f)) {
      issues.push({ code: 'unavailable_feature', severity: 'error', path: `requiredFeatures.${i}`, message: `feature '${f}' is not in the allowed set` });
    }
  });

  const haystack = [
    draft.thesis,
    draft.targetBehavior,
    ...draft.ruleAction.rules.flatMap((r) => [r.when, r.rationale ?? '']),
  ].join(' \n ').toLowerCase();

  const liveHits = LIVE_INTENT_DENYLIST.filter((t) => haystack.includes(t));
  if (liveHits.length > 0) {
    issues.push({ code: 'live_intent', severity: 'error', path: 'thesis', message: `live-execution markers not allowed: ${liveHits.join(', ')}` });
  }
  const lookaheadHits = LOOKAHEAD_DENYLIST.filter((t) => haystack.includes(t));
  if (lookaheadHits.length > 0) {
    issues.push({ code: 'lookahead_marker', severity: 'error', path: 'thesis', message: `lookahead markers not allowed: ${lookaheadHits.join(', ')}` });
  }
  const authorityHits = AUTHORITY_DENYLIST.filter((t) => haystack.includes(t));
  if (authorityHits.length > 0) {
    issues.push({ code: 'authority_violation', severity: 'error', path: 'thesis', message: `runner-owned authority claims not allowed: ${authorityHits.join(', ')}` });
  }

  issues.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.code, b.code));
  const status = issues.some((i) => i.severity === 'error') ? 'rejected' : 'validated';
  return { status, issues, normalizedFeatures };
}
