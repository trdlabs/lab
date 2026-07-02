import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrozenCase } from './types.ts';
import { computeSnapshotId, freezeDataset, writeSnapshot, loadSnapshot } from './dataset.ts';

const cases = (created: string): FrozenCase[] => [
  { id: 'c1', input: {} as any, label: 'improve', labelSource: 'teacher', teacherModel: 'gpt-5.5', rationale: 'r', createdAt: created },
];

describe('wfo-gate1 dataset', () => {
  it('snapshotId ignores volatile createdAt — same content → same id', () => {
    expect(computeSnapshotId(cases('2026-01-01'))).toBe(computeSnapshotId(cases('2026-09-09')));
  });

  it('snapshotId changes when a label changes', () => {
    const a = cases('t');
    const b = [{ ...a[0]!, label: 'stop_not_worth' as const }];
    expect(computeSnapshotId(a)).not.toBe(computeSnapshotId(b));
  });

  it('freeze → write → load round-trips and never mutates labels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfo-ds-'));
    const ds = freezeDataset(cases('t'), { gitSha: 'abc', sourceRef: 'db', now: 't' });
    const p = writeSnapshot(dir, ds);
    const loaded = loadSnapshot(dir, ds.snapshotId);
    expect(loaded.cases[0]!.label).toBe('improve');
    expect(loaded.snapshotId).toBe(ds.snapshotId);
  });
});
