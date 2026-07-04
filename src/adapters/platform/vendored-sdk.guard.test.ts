import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Machine guarantee that lab consumes the /ops-read-bearing @trdlabs/sdk at an EXACT published npm
// version (not a floating range / sibling file path / stale version without /ops-read). The SDK moved
// to the trdlabs org and is published on npm as @trdlabs/sdk; the pin form is now an exact npm version
// (x.y.z), no longer a GitHub Release tarball URL.
const EXPECTED_OPS_VERSION = 'ops.6';
const SPEC_RE = /^\d+\.\d+\.\d+$/;

interface PkgJson { dependencies?: Record<string, string> }

/** Pure: returns specifier problems ([] = clean). No SDK import — safe to unit-test. */
export function checkSpecifier(pkg: PkgJson): string[] {
  const errs: string[] = [];
  const spec = pkg.dependencies?.['@trdlabs/sdk'];
  if (!spec) { errs.push('@trdlabs/sdk missing from dependencies'); return errs; }
  if (!SPEC_RE.test(spec)) errs.push(`@trdlabs/sdk specifier '${spec}' is not an exact published npm version (x.y.z)`);
  return errs;
}

describe('vendored SDK guard', () => {
  it('pins the @trdlabs/sdk specifier to an exact published npm version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PkgJson;
    expect(checkSpecifier(pkg)).toEqual([]);
  });

  it('rejects a non-exact specifier (unit)', () => {
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': '^0.3.0' } }).length).toBeGreaterThan(0);
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': 'file:./vendor/trading-platform-sdk/trading-platform-sdk-0.3.0.tgz' } }).length).toBeGreaterThan(0);
    expect(checkSpecifier({ dependencies: {} }).length).toBeGreaterThan(0);
  });

  it('the released SDK exposes /ops-read at contract version ops.6', async () => {
    const mod = await import('@trdlabs/sdk/ops-read');
    expect(mod.OPS_READ_CONTRACT_VERSION).toBe(EXPECTED_OPS_VERSION);
  });
});
