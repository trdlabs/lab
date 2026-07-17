// Map a lab ModuleBundle → the backtester's submitted moduleBundle wire shape.
//
// The lab taxonomy maps onto the backtester wire kind: the cross-repo demo path submits hypothesis
// overlays through the backtester overlay engine, so `hypothesis_overlay` surfaces as the backtester
// `overlay` kind. The canonical executable bundle is built via the SDK builder so it is exactly the
// inline bundle the service accepts (canonical file ordering, frozen, pinned bundleContractVersion).

import { createModuleBundle, createModuleManifest } from '@trdlabs/backtester-sdk/builder';
import type { ModuleBundle as BacktesterModuleBundle } from '@trdlabs/backtester-sdk/contracts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { OVERLAY_INTERCEPTION_POINT } from '../../domain/overlay-manifest-meta.ts';

/** BundleManifest is not re-exported from the SDK; derive it from the builder's return type. */
type BundleManifest = ReturnType<typeof createModuleManifest>;

export interface ToBacktesterBundleOptions {
  /**
   * For overlay submissions: the baseline strategy the overlay targets. The backtester validates
   * `targetStrategyRef` against the run's baseline, so a preset-driven submission must set this to
   * the preset's baselineRef.id (not the lab's own strategy profile).
   */
  readonly targetStrategyRef?: string;
  /** 017 contract version the backtester advertises (from discoverRegistry()), for the overlay manifest. */
  readonly contractVersion?: string;
}

export function toBacktesterBundle(bundle: ModuleBundle, opts: ToBacktesterBundleOptions = {}): BacktesterModuleBundle {
  const kind = bundle.manifest.moduleKind === 'hypothesis_overlay' ? 'overlay' : 'strategy';
  // The lab manifest has no version; prefer the overlay manifest meta, else a stable default.
  const version = bundle.overlayMeta?.version ?? '1.0.0';
  // 0.3.0: CreateModuleManifestInput requires all fields; provide defaults (overlay path overrides all).
  const base = createModuleManifest({
    id: bundle.manifest.moduleId,
    version,
    kind,
    name: bundle.manifest.moduleId,
    summary: '',
    rationale: '',
    hooks: ['onBarClose'] as const,
    paramsSchema: { type: 'object', additionalProperties: false } as object,
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true },
  });

  // Overlay submissions need the RICH 017 overlay manifest: the backtester reads interceptionPoint /
  // hooks / targetStrategyRef from the materialized manifest.json to validate + resolve the overlay
  // (runner reads ro.manifest.*). The SDK builder manifest is minimal {id,version,kind,bundleCV}; the
  // lab projects its overlay metadata on top (the 017 overlay-manifest projection).
  const manifest: BundleManifest =
    kind === 'overlay'
      ? ({
          ...base,
          kind: 'overlay',
          name: bundle.overlayMeta?.name ?? bundle.manifest.moduleId,
          summary: bundle.overlayMeta?.summary ?? bundle.manifest.moduleId,
          rationale: bundle.overlayMeta?.rationale ?? bundle.manifest.moduleId,
          author: 'agent',
          status: 'research_only',
          hooks: ['apply'],
          interceptionPoint: bundle.overlayMeta?.interceptionPoint ?? OVERLAY_INTERCEPTION_POINT,
          targetStrategyRef: opts.targetStrategyRef ?? bundle.overlayMeta?.targetStrategyRef ?? '',
          paramsSchema: bundle.overlayMeta?.paramsSchema ?? { type: 'object', additionalProperties: false },
          params: {},
          capabilities: { platformSdk: true },
          dataNeeds: { closedCandlesUpToCurrent: true },
          ...(opts.contractVersion !== undefined ? { contractVersion: opts.contractVersion } : {}),
        } as unknown as BundleManifest)
      : base;

  return createModuleBundle({
    manifest,
    entry: bundle.manifest.entry,
    files: bundle.files,
  });
}
