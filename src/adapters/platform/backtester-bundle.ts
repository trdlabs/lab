// Map a lab ModuleBundle → the backtester's submitted moduleBundle wire shape.
//
// The backtester (Slices 1-4) executes STRATEGY bundles exporting `signals(candles, seed): boolean[]`;
// it does not (yet) host the platform overlay runner. So this mapping is lossy for real overlays: lab
// `moduleKind: 'hypothesis_overlay'` is carried as the backtester's only kind, `'strategy'`. Full
// overlay-module execution parity awaits lifting the platform runner (out of Slice 5 scope) — until
// then the backtester path is "green" for strategy-signals bundles, and sp4_mock is NOT retired.

import { BUNDLE_CONTRACT_VERSION, type ModuleBundle as BacktesterModuleBundle } from '@trading-backtester/client';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

export function toBacktesterBundle(bundle: ModuleBundle): BacktesterModuleBundle {
  return {
    manifest: {
      id: bundle.manifest.moduleId,
      // The lab manifest has no version; prefer the overlay manifest meta, else a stable default.
      version: bundle.overlayMeta?.version ?? '1.0.0',
      kind: 'strategy',
      bundleContractVersion: BUNDLE_CONTRACT_VERSION,
    },
    entry: bundle.manifest.entry,
    files: bundle.files,
  };
}
