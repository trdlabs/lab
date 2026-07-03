import type { StrategyBuilder, StrategyBuilderInput, BuildFeedback } from '../ports/strategy-builder.port.ts';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';
import { assembleStrategyBundle } from '../domain/strategy-bundle.ts';
import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import { validateStrategyBundle } from '../validation/strategy-bundle-validator.ts';

export interface ProofOutcome {
  readonly proven: boolean;
  readonly attempts: number;
  readonly lastVerdict?: ProofVerdict;
  readonly lastViolations?: string[];
  /** G2 (2026-07-03): собранный бандл при proven — для отправки в paper-intake (аддитивно). */
  readonly bundle?: AssembledStrategyBundle;
}

export interface BuilderProofLoopDeps {
  readonly builder: StrategyBuilder;
  readonly prover: BundleProverPort;
  readonly input: StrategyBuilderInput;
  readonly maxIterations?: number;
}

function verdictToFeedback(v: Extract<ProofVerdict, { proven: false }>): BuildFeedback {
  if ('divergence' in v) return { kind: 'parity', diff: v.divergence };
  // BuildFeedback has only validation|parity, so a platform runtime/integrity failure is surfaced to the builder as a validation violation.
  return { kind: 'validation', violations: [v.failClosed.reason] };
}

export async function runBuilderProofLoop(deps: BuilderProofLoopDeps): Promise<ProofOutcome> {
  const maxIterations = deps.maxIterations ?? 5;
  let feedback: BuildFeedback | undefined;
  let lastVerdict: ProofVerdict | undefined;
  let lastViolations: string[] | undefined;

  for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
    const out = await deps.builder.build({ ...deps.input, feedback });
    const bundle = await assembleStrategyBundle(out);

    const verdict = validateStrategyBundle(bundle);
    if (verdict.status === 'rejected') {
      lastViolations = verdict.violations;
      lastVerdict = undefined;
      feedback = { kind: 'validation', violations: verdict.violations };
      continue;
    }

    const proof = await deps.prover.prove(bundle.source);
    if (proof.proven) return { proven: true, attempts: attempt, bundle };
    if ('divergence' in proof) {
      lastVerdict = proof;
      lastViolations = undefined;
    } else {
      // failClosed → validation feedback; clear stale parity field
      lastVerdict = undefined;
    }
    feedback = verdictToFeedback(proof);
  }

  return { proven: false, attempts: maxIterations, lastVerdict, lastViolations };
}
