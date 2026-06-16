// src/experiments/strategy-analyst/fixtures.ts
import { createHash } from 'node:crypto';
import type { FixtureRef } from './types.ts';

const DIR = 'docs/fixtures/strategies';

export const FIXTURES: Record<string, FixtureRef> = {
  'long-oi': {
    id: 'long-oi',
    sourcePath: `${DIR}/long-oi-strategy-source.md`,
    notesPath: `${DIR}/long-oi-strategy-research-notes.md`,
    rubricPath: `${DIR}/long-oi-strategy-rubric.md`,
  },
};

export function resolveFixture(id: string): FixtureRef {
  const ref = FIXTURES[id];
  if (!ref) throw new Error(`unknown fixture "${id}" (known: ${Object.keys(FIXTURES).join(', ')})`);
  return ref;
}

export function fingerprintSource(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}
