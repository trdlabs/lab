import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodeDir } from './read-code-dir.ts';

describe('readCodeDir', () => {
  it('reads .ts recursively, sorted by path, excludes *.test.ts and non-.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcd-'));
    try {
      writeFileSync(join(dir, 'b.ts'), 'B');
      writeFileSync(join(dir, 'a.ts'), 'A');
      writeFileSync(join(dir, 'a.test.ts'), 'TEST');
      writeFileSync(join(dir, 'readme.md'), 'MD');
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'c.ts'), 'C');
      const files = readCodeDir(dir);
      expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'sub/c.ts']);
      expect(files.find((f) => f.path === 'a.ts')?.content).toBe('A');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
