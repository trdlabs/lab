// src/orchestrator/handlers/author-strategy-bundle.handler.ts
import type { StrategyBuilder, StrategyBuilderInput } from '../../ports/strategy-builder.port.ts';
import type { ArtifactStorePort } from '../../ports/artifact-store.port.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type {
  BacktesterStrategyPort,
  StrategyRunResult,
  StrategyRunSubmission,
} from '../../ports/backtester-strategy.port.ts';
import { assembleStrategyBundle } from '../../domain/strategy-bundle.ts';
import { validateStrategyBundle } from '../../validation/strategy-bundle-validator.ts';

export interface AuthorStrategyInput extends StrategyBuilderInput {
  /** Optional curated hash to pin against; defaults to a zeroed placeholder. */
  readonly curatedBundleHash?: string;
  /** Optional backtester scope; defaults to a minimal placeholder. */
  readonly scope?: StrategyRunSubmission['scope'];
}

export interface AuthorStrategyResult {
  status: 'signed' | 'equivalent' | 'divergent' | 'rejected' | 'unavailable';
  bundleHash?: string;
  bundleRef?: ArtifactRef;
  evidenceRef?: ArtifactRef;
  reason?: string;
  violations?: string[];
  divergence?: StrategyRunResult['divergence'];
}

const DEFAULT_CURATED_HASH = `sha256:${'0'.repeat(64)}`;
const DEFAULT_SCOPE: StrategyRunSubmission['scope'] = {
  datasetRef: 'default',
  window: { fromMs: 0, toMs: 0 },
  symbols: ['BTCUSDT'],
  timeframe: '1m',
};

/**
 * Orchestration heart of strategy-bundle authoring.
 *
 * Flow:
 *   build → assemble → validate (fail-closed: rejected → return, no persist, no submit)
 *   → persist bundle → submit → on signed persist evidence → return.
 *
 * All non-happy outcomes (equivalent/divergent/rejected/unavailable) are normal returns.
 * Only infra errors (artifact write failure, assemble throw) propagate as exceptions.
 */
export async function authorStrategyBundleHandler(
  input: AuthorStrategyInput,
  deps: {
    strategyBuilder: StrategyBuilder;
    artifacts: ArtifactStorePort;
    backtesterStrategy: BacktesterStrategyPort;
  },
): Promise<AuthorStrategyResult> {
  // Step 1: build
  const out = await deps.strategyBuilder.build(input);

  // Step 2: assemble (may throw on esbuild infra errors — let propagate)
  const assembled = await assembleStrategyBundle(out);

  // Step 3: validate — fail-closed short-circuit (no persist, no submit for untrusted code)
  const verdict = validateStrategyBundle(assembled);
  if (verdict.status === 'rejected') {
    return {
      status: 'rejected',
      bundleHash: assembled.bundleHash,
      reason: verdict.reason,
      violations: verdict.violations,
    };
  }

  // Step 4: persist bundle before submit (persist-before-submit invariant)
  const bundleRef = await deps.artifacts.put(
    JSON.stringify({
      source: assembled.source,
      manifest: assembled.manifest,
      bundleHash: assembled.bundleHash,
    }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'strategy-builder' },
  );
  const bundleHash = assembled.bundleHash;

  // Step 5: submit to backtester
  const result = await deps.backtesterStrategy.submitStrategyRun({
    bundleBytes: assembled.bytes,
    bundleHash: assembled.bundleHash,
    manifest: assembled.manifest,
    curatedBundleHash: input.curatedBundleHash ?? DEFAULT_CURATED_HASH,
    scope: input.scope ?? DEFAULT_SCOPE,
  });

  // Step 6: map backtester result — evidence persisted ONLY on signed
  if (result.status === 'signed') {
    const evidenceRef = await deps.artifacts.put(
      JSON.stringify(result.evidence),
      { kind: 'backtest_evidence', mime_type: 'application/json', producer: 'backtester' },
    );
    return { status: 'signed', bundleHash, bundleRef, evidenceRef };
  }

  return {
    status: result.status,
    bundleHash,
    bundleRef,
    ...(result.divergence !== undefined ? { divergence: result.divergence } : {}),
  };
}
