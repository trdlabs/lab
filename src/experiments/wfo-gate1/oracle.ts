import type { Gate1Input } from '../../ports/wfo-agents.port.ts';
import { classifyEntryAffectingParams } from '../../domain/wfo.ts';
import type { OracleLabel } from './types.ts';

export function labelObvious(input: Gate1Input): OracleLabel {
  // Recompute entryAffecting from profile to avoid stale arrays
  const { entryAffecting } = classifyEntryAffectingParams(input.profile.profile.parameters);

  const totalTrades = input.baselineMetrics.totalTrades;
  const hasEntrySignalEvidence = input.hasEntrySignalEvidence;

  // Rule 1: totalTrades === 0 && entryAffecting.length === 0
  if (totalTrades === 0 && entryAffecting.length === 0) {
    return { label: 'stop_insufficient_evidence', confidence: 'obvious' };
  }

  // Rule 2: totalTrades === 0 && entryAffecting.length > 0 && hasEntrySignalEvidence === true
  if (totalTrades === 0 && entryAffecting.length > 0 && hasEntrySignalEvidence === true) {
    return { label: 'allow_exploratory_sweep', confidence: 'obvious' };
  }

  // Rule 3: totalTrades === 0 && entryAffecting.length > 0 && hasEntrySignalEvidence === false
  if (totalTrades === 0 && entryAffecting.length > 0 && hasEntrySignalEvidence === false) {
    return { label: 'stop_insufficient_evidence', confidence: 'obvious' };
  }

  // Rule 4: totalTrades > 0
  if (totalTrades > 0) {
    return { needsTeacher: true };
  }

  // Fallback (should not reach here based on the rules)
  return { needsTeacher: true };
}
