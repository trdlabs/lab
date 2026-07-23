// src/research/snapshot-tier-catalog.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshotTierCatalog, requiredTierForDays } from './snapshot-tier-catalog.ts';

const MINUTES_PER_DAY = 1440;

function tmpCatalogDir(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-tier-catalog-test-'));
  writeFileSync(join(dir, 'snapshot-tiers.json'), contents, 'utf8');
  return dir;
}

describe('loadSnapshotTierCatalog (repo-local — pins snapshot-tiers.json is committed and valid)', () => {
  it('reads the real repo-root snapshot-tiers.json: schemaVersion, T2 present, T2 clears the 30d floor', () => {
    const catalog = loadSnapshotTierCatalog();
    expect(catalog.schemaVersion).toBe('snapshot-tiers.1');
    expect(catalog.tiers.T2).toBeDefined();
    expect(catalog.tiers.T2!.common_present_minutes / MINUTES_PER_DAY).toBeGreaterThanOrEqual(30);
  });
});

describe('requiredTierForDays', () => {
  it('30 days → T2 (the only committed tier clearing the WFO floor)', () => {
    const result = requiredTierForDays(30);
    expect(result).toEqual({
      tierId: 'T2',
      ref: 'wfo/2026-06-09-to-2026-07-20-vps-wfo42d',
      usableDays: 59_893 / MINUTES_PER_DAY,
    });
  });

  it('picks the minimal sufficient tier, not the deepest — 4 days is already covered by T1', () => {
    const result = requiredTierForDays(4);
    expect(result?.tierId).toBe('T1');
  });

  it('returns undefined when no tier clears the requested depth', () => {
    expect(requiredTierForDays(9999)).toBeUndefined();
  });
});

describe('loadSnapshotTierCatalog fail-closed behavior', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('throws when snapshot-tiers.json is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-tier-catalog-test-'));
    expect(() => loadSnapshotTierCatalog(dir)).toThrow(/snapshot-tiers\.json/);
  });

  it('throws on an unrecognized schemaVersion', () => {
    dir = tmpCatalogDir(JSON.stringify({ schemaVersion: 'snapshot-tiers.2', tiers: {} }));
    expect(() => loadSnapshotTierCatalog(dir)).toThrow(/schemaVersion/);
  });

  it('throws on malformed JSON', () => {
    dir = tmpCatalogDir('{ not valid json');
    expect(() => loadSnapshotTierCatalog(dir)).toThrow();
  });
});
