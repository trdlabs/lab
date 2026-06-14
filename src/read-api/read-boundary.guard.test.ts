import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Roots scanned recursively + explicit port files (the read boundary, §11 of the spec).
const ROOT_DIRS = ['src/read-api', 'src/adapters/read'];
const PORT_FILES = [
  'src/ports/keyset.ts',
  'src/ports/hypothesis-read.port.ts',
  'src/ports/backtest-read.port.ts',
  'src/ports/agent-event-read.port.ts',
  'src/ports/agent-event-stream.port.ts',
];

// The read boundary must not import the write side or the platform.
const FORBIDDEN: RegExp[] = [
  /orchestrator\/task-intake/,
  /ports\/task-queue/,
  /adapters\/queue/,
  /worker\//,
  /orchestrator\/workflow-router/,
  /orchestrator\/handlers/,
  /adapters\/repository\//,
  /trading-platform/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).filter((s): s is string => s !== undefined);
}

describe('read boundary import guard', () => {
  const files = [...ROOT_DIRS.flatMap(walk), ...PORT_FILES];

  it('covers the expected file set (sanity)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file} imports nothing forbidden`, () => {
      const offenders = importSpecifiers(file).filter((spec) => FORBIDDEN.some((re) => re.test(spec)));
      expect(offenders, `${file} imports forbidden: ${offenders.join(', ')}`).toEqual([]);
    });
  }
});
