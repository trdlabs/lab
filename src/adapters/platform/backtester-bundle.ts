// Map a lab ModuleBundle → the backtester's submitted moduleBundle wire shape.
//
// Map the lab module taxonomy onto the backtester wire kind. The current cross-repo
// demo path submits hypothesis overlays through the backtester overlay engine, so
// `hypothesis_overlay` must surface as the backtester `overlay` kind.

import { BUNDLE_CONTRACT_VERSION, type ModuleBundle as BacktesterModuleBundle } from '@trading-backtester/client';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

export function toBacktesterBundle(bundle: ModuleBundle): BacktesterModuleBundle {
  const kind = bundle.manifest.moduleKind === 'hypothesis_overlay' ? 'overlay' : 'strategy';
  return {
    manifest: {
      id: bundle.manifest.moduleId,
      // The lab manifest has no version; prefer the overlay manifest meta, else a stable default.
      version: bundle.overlayMeta?.version ?? '1.0.0',
      kind,
      bundleContractVersion: BUNDLE_CONTRACT_VERSION,
    },
    entry: bundle.manifest.entry,
    files: bundle.files,
  };
}
