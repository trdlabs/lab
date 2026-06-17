import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Machine guarantee that lab vendors the /ops-read-bearing SDK (not a stale 0.3.0 without it).
const EXPECTED_OPS_VERSION = 'ops.3';
const SPEC_RE = /^file:(\.\/vendor\/trading-platform-sdk\/trading-platform-sdk-\d+\.\d+\.\d+\.tgz)$/;

interface PkgJson { dependencies?: Record<string, string> }

/** Pure: returns specifier problems ([] = clean). No SDK import — safe to unit-test. */
export function checkSpecifier(pkg: PkgJson): string[] {
  const errs: string[] = [];
  const spec = pkg.dependencies?.['@trading-platform/sdk'];
  if (!spec) { errs.push('@trading-platform/sdk missing from dependencies'); return errs; }
  if (!SPEC_RE.test(spec)) errs.push(`@trading-platform/sdk specifier '${spec}' is not the vendored ./vendor/trading-platform-sdk/*.tgz file`);
  return errs;
}

describe('vendored SDK guard', () => {
  it('pins the @trading-platform/sdk specifier to the vendored tgz', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PkgJson;
    expect(checkSpecifier(pkg)).toEqual([]);
  });

  it('rejects a non-vendored specifier (unit)', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': '^0.3.0' } }).length).toBeGreaterThan(0);
    expect(checkSpecifier({ dependencies: {} }).length).toBeGreaterThan(0);
  });

  it('the vendored SDK exposes /ops-read at contract version ops.3', async () => {
    const mod = await import('@trading-platform/sdk/ops-read');
    expect(mod.OPS_READ_CONTRACT_VERSION).toBe(EXPECTED_OPS_VERSION);
  });
});
