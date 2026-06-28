import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { BuildFeedback } from '../../ports/strategy-builder.port.ts';

export function buildStrategyUserMessage(
  profile: AnalystProfileOutput,
  feedback?: BuildFeedback,
): string {
  const lines: string[] = [
    '=== STRATEGY PROFILE ===',
    `Direction: ${profile.direction}`,
    `Core Idea: ${profile.coreIdea}`,
    `Summary: ${profile.summary}`,
    '',
    '--- Entry Conditions ---',
    ...profile.entryConditions.map((c) => `- ${c}`),
    '',
    '--- Exit Conditions ---',
    ...profile.exitConditions.map((c) => `- ${c}`),
    '',
    '--- Required Market Features ---',
    ...profile.requiredMarketFeatures.map((f) => `- ${f}`),
    '',
    '--- Timeframes ---',
    profile.timeframes.join(', '),
    '',
    '--- Indicators ---',
    ...(profile.indicators.length > 0 ? profile.indicators.map((i) => `- ${i}`) : ['(none)']),
    '',
    '--- Parameters ---',
    ...(profile.parameters.length > 0
      ? profile.parameters.map(
          (p) => `- ${p.name}: ${p.value}${p.unit ? ` ${p.unit}` : ''} — ${p.description}`,
        )
      : ['(none)']),
    '',
    '--- Position Management ---',
    profile.positionManagementSummary ?? '(not specified)',
    '',
    '--- Risk Management ---',
    profile.riskManagementSummary ?? '(not specified)',
    '',
    '--- Watch Lifecycle ---',
    profile.watchLifecycleSummary ?? '(not specified)',
    '',
    '--- Runner-Owned Authorities (do NOT implement these) ---',
    ...profile.runnerOwnedAuthorities.map((a) => `- ${a}`),
    '',
    '--- Unknowns ---',
    ...(profile.unknowns.length > 0 ? profile.unknowns.map((u) => `- ${u}`) : ['(none)']),
    '',
    '=== TASK ===',
    'Author a self-contained ESM module. Return an object with two fields:',
    '  manifest — the strategy manifest (kind: "strategy", plus id/name/hooks/capabilities)',
    '  source   — the complete source code for createStrategyModule',
    '',
    'The source MUST export a default function: export default function createStrategyModule(...)',
    'Use ONLY onBarClose and/or onPositionBar lifecycle hooks (no others).',
    'Do NOT include bundleHash or bytes — the host computes these.',
    'No import or require statements — the module must be self-contained.',
  ];

  if (feedback !== undefined) {
    lines.push('', '=== FEEDBACK FROM PREVIOUS ATTEMPT ===');
    if (feedback.kind === 'validation') {
      lines.push('Validation violations to fix:');
      for (const v of feedback.violations) {
        lines.push(`- ${v}`);
      }
    } else {
      const { bar, field, expected, actual } = feedback.diff;
      lines.push(
        `Parity mismatch at bar ${bar}:`,
        `  field:    ${field}`,
        `  expected: ${JSON.stringify(expected)}`,
        `  actual:   ${JSON.stringify(actual)}`,
      );
    }
  }

  return lines.join('\n');
}
