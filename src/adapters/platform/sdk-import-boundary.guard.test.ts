import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// @trading-platform/* may be imported ONLY from the research-platform port and the platform adapter dir.
const ALLOWED_FILES = new Set<string>([
  'src/ports/research-platform.port.ts',
  'src/ports/bot-results-read.port.ts',
]);
const ALLOWED_DIR = 'src/adapters/platform/';

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

describe('SDK import boundary', () => {
  const files = walk('src');

  it('covers a meaningful file set (sanity)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${file} imports @trading-platform/* only from the platform boundary`, () => {
      const sdk = importSpecifiers(file).filter((s) => s.startsWith('@trading-platform/'));
      if (sdk.length === 0) return;
      const allowed = ALLOWED_FILES.has(file) || file.startsWith(ALLOWED_DIR);
      expect(allowed, `${file} imports ${sdk.join(', ')} outside the platform boundary`).toBe(true);
    });
  }
});
