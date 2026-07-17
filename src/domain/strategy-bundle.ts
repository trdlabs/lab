import * as esbuild from 'esbuild';
import { computeBundleHash, createModuleManifest } from '@trdlabs/backtester-sdk/builder';
import type { StrategyBuilderOutput } from '../ports/strategy-builder.port.ts';

export interface AssembledStrategyBundle {
  readonly bytes: Uint8Array;
  readonly source: string;
  readonly manifest: ReturnType<typeof createModuleManifest>;
  readonly bundleHash: string;
}

export async function assembleStrategyBundle(o: StrategyBuilderOutput): Promise<AssembledStrategyBundle> {
  const result = await esbuild.build({
    stdin: { contents: o.source, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });

  const outputFile = result.outputFiles[0];
  if (!outputFile) throw new Error('assembleStrategyBundle: esbuild produced no output');
  const bytes = outputFile.contents;

  // Assert self-contained: no import/require/from left after stripping export default
  const decoded = new TextDecoder().decode(bytes);
  const stripped = decoded.replace(/export\s+default/g, '');
  if (/\b(import|require)\s*[(.]|\bfrom\s+['"]/.test(stripped)) {
    throw new Error('assembleStrategyBundle: bundle is not self-contained — imports/require detected in output');
  }

  const manifest = createModuleManifest({ kind: 'strategy', ...o.manifestMeta });
  const bundleHash = computeBundleHash(bytes);

  return { bytes, source: o.source, manifest, bundleHash };
}
