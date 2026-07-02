import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify } from '../../orchestrator/handlers/backtest-support.ts';
import type { FrozenCase, FrozenDataset } from './types.ts';

export function computeSnapshotId(cases: FrozenCase[]): string {
  const canonicalProjection = cases.map((c) => ({
    id: c.id,
    input: c.input,
    label: c.label,
    labelSource: c.labelSource,
    teacherModel: c.teacherModel,
    rationale: c.rationale,
  }));
  return createHash('sha256').update(stableStringify(canonicalProjection)).digest('hex');
}

export function freezeDataset(
  cases: FrozenCase[],
  meta: { gitSha: string; sourceRef: string; now: string }
): FrozenDataset {
  return {
    snapshotId: computeSnapshotId(cases),
    createdAt: meta.now,
    gitSha: meta.gitSha,
    sourceRef: meta.sourceRef,
    cases,
  };
}

export function writeSnapshot(baseDir: string, dataset: FrozenDataset): string {
  mkdirSync(baseDir, { recursive: true });
  const filePath = join(baseDir, `${dataset.snapshotId}.json`);
  writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf8');
  return filePath;
}

export function loadSnapshot(baseDir: string, snapshotId: string): FrozenDataset {
  const filePath = join(baseDir, `${snapshotId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Snapshot file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf8');
  return JSON.parse(content) as FrozenDataset;
}
