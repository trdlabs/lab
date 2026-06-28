import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';

/**
 * Real-адаптер: шеллит платформенный proof-seam (trading-platform 050 prove_bundle.mjs).
 * `cli` — абсолютный путь к prove_bundle.mjs (вызывающий резолвит из PLATFORM_REPO_PATH).
 * exit≠0 = опер-сбой CLI → throw (инфра, не вердикт). Любой записанный вердикт → парсится.
 */
export function createShellBundleProver(opts: { readonly cli: string }): BundleProverPort {
  return {
    async prove(bundleSource: string): Promise<ProofVerdict> {
      const dir = mkdtempSync(join(tmpdir(), 'proof-'));
      const bundlePath = join(dir, 'bundle.mjs');
      const outPath = join(dir, 'verdict.json');
      try {
        writeFileSync(bundlePath, bundleSource);
        const res = spawnSync('node', [opts.cli, '--bundle', bundlePath, '--out', outPath], { encoding: 'utf8' });
        if (res.error) {
          throw new Error(`prove_bundle CLI не запущен: ${res.error.message}`);
        }
        if (res.status !== 0) {
          throw new Error(`prove_bundle CLI опер-сбой (exit ${res.status ?? `signal:${res.signal}`}): ${res.stderr ?? ''}`);
        }
        return JSON.parse(readFileSync(outPath, 'utf8')) as ProofVerdict;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
