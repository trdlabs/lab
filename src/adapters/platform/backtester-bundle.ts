// Map a lab ModuleBundle → the backtester's submitted moduleBundle wire shape.
//
// The lab taxonomy maps onto the backtester wire kind: the cross-repo demo path submits hypothesis
// overlays through the backtester overlay engine, so `hypothesis_overlay` surfaces as the backtester
// `overlay` kind. The canonical executable bundle is built via the SDK builder so it is exactly the
// inline bundle the service accepts (canonical file ordering, frozen, pinned bundleContractVersion).

import { createModuleBundle, createModuleManifest } from '@trading-backtester/sdk/builder';
import type { ModuleBundle as BacktesterModuleBundle } from '@trading-backtester/sdk/contracts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

export function toBacktesterBundle(bundle: ModuleBundle): BacktesterModuleBundle {
  const kind = bundle.manifest.moduleKind === 'hypothesis_overlay' ? 'overlay' : 'strategy';
  // The lab manifest has no version; prefer the overlay manifest meta, else a stable default.
  const manifest = createModuleManifest({
    id: bundle.manifest.moduleId,
    version: bundle.overlayMeta?.version ?? '1.0.0',
    kind,
  });
  return createModuleBundle({
    manifest,
    entry: bundle.manifest.entry,
    files: bundle.files,
  });
}
