import type { ArtifactRef } from '../domain/types.ts';
import type { ArtifactStorePort } from '../ports/artifact-store.port.ts';
import type { StrategyManifestMeta } from '../ports/strategy-builder.port.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../domain/strategy-bundle.ts';

/**
 * Shape persisted by run-strategy-baseline.mts (step 3, the 'strategy_bundle' artifact) and by
 * authorStrategyBundleHandler: `{ source, manifest, bundleHash }` — the exact fields of
 * AssembledStrategyBundle minus `bytes` (bytes are re-derived from `source`, not persisted).
 *
 * `manifest` here is the FULL createModuleManifest() output (AssembledStrategyBundle['manifest']),
 * not the narrower StrategyManifestMeta input createModuleManifest was originally called with.
 * createModuleManifest is a pure function of its named input fields (see
 * @trading-backtester/sdk/builder), and ModuleManifest is structurally a superset of
 * CreateModuleManifestInput (every required input field is present, computed-only output fields
 * like contractVersion/bundleContractVersion are simply ignored on re-read) — so re-passing the
 * persisted manifest back in as manifestMeta reproduces the identical manifest object.
 */
interface PersistedStrategyBundleArtifact {
  readonly source: string;
  readonly manifest: AssembledStrategyBundle['manifest'];
  readonly bundleHash: string;
}

function isPersistedStrategyBundleArtifact(value: unknown): value is PersistedStrategyBundleArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['source'] === 'string'
    && typeof v['bundleHash'] === 'string'
    && typeof v['manifest'] === 'object' && v['manifest'] !== null;
}

/**
 * Rebuild the exact AssembledStrategyBundle a baseline experiment validated from its persisted
 * strategy_bundle artifact. NO LLM rebuild — determinism is the whole point (WFO must optimize
 * the same bundle the baseline validated). Fails fast if the reassembled hash drifts from the
 * persisted one (corruption / format drift).
 */
export async function reconstructStrategyBundle(
  artifacts: ArtifactStorePort,
  ref: ArtifactRef,
): Promise<AssembledStrategyBundle> {
  const raw = (await artifacts.get(ref)).toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `strategy_bundle artifact ${ref.artifact_id} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isPersistedStrategyBundleArtifact(parsed)) {
    throw new Error(`strategy_bundle artifact ${ref.artifact_id} is missing source/manifest/bundleHash`);
  }

  const bundle = await assembleStrategyBundle({
    source: parsed.source,
    manifestMeta: parsed.manifest as StrategyManifestMeta,
  });

  if (bundle.bundleHash !== parsed.bundleHash) {
    throw new Error(
      `strategy_bundle artifact ${ref.artifact_id} hash mismatch: reassembled ${bundle.bundleHash} != persisted ${parsed.bundleHash}`,
    );
  }

  return bundle;
}
