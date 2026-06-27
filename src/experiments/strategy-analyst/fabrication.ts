// src/experiments/strategy-analyst/fabrication.ts
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';

// Fabrication patterns for the negative check. Leverage requires >=2x OR the explicit word,
// so DCA size hints (1.2x/1.5x) are NOT flagged.
export const FAB_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'leverage_x', re: /(?<![.\d])\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*[x×]\b/i },
  { label: 'leverage_word', re: /leverage\s*[:=]?\s*\d/i },
  { label: 'leverage_ru', re: /плеч\w*\s*[:=]?\s*\d/i },
  { label: 'base_size_usd', re: /\$\s*\d|\b\d+\s*(?:usd|usdt|dollars?)\b|base[ _]?order\s*[:=]?\s*\d/i },
  { label: 'equity_fraction', re: /\b\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:equity|account|balance|capital|portfolio|deposit|депозит)/i },
];

export const FAB_PARAM_NAME = /leverage|плеч|margin|марж|base.?order|position.?siz|order.?siz|notional/i;

/** Pure: returns the fabrication labels for a profile (pattern order, then `param_sizing` if any
 *  sizing-named parameter carries a value). Empty array == clean. Non-global regexes => stateless. */
export function detectFabrication(p: AnalystProfileOutput): string[] {
  const matched: string[] = [];
  const riskText = (p.riskManagementSummary ?? '').toString();
  for (const { label, re } of FAB_PATTERNS) if (re.test(riskText)) matched.push(label);
  const paramFab = p.parameters.some((param) => param.value != null && FAB_PARAM_NAME.test(param.name));
  if (paramFab) matched.push('param_sizing');
  return matched;
}
