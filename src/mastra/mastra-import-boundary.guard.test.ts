// src/mastra/mastra-import-boundary.guard.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// @mastra/core VALUE imports and `new Agent(` / `new Mastra(` may appear ONLY under src/mastra/**.
// Everywhere else may import the Agent TYPE only: `import type { Agent } from '@mastra/core/agent'`.
// The offline provider probe deliberately constructs an Agent to prove model assignability.
const ALLOWED_DIR = 'src/mastra/';
const ALLOWED_FILES = new Set<string>(['src/adapters/llm/provider-probe.test.ts']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function mastraValueViolations(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const v: string[] = [];
  for (const line of src.split('\n')) {
    if (/\bfrom\s+'@mastra\/core(?:\/[^']*)?'/.test(line) && !/^\s*import\s+type\b/.test(line)) {
      v.push(`value import: ${line.trim()}`);
    }
  }
  if (/\bnew\s+Agent\b\s*\(/.test(src)) v.push('new Agent(');
  if (/\bnew\s+Mastra\b\s*\(/.test(src)) v.push('new Mastra(');
  return v;
}

describe('Mastra import boundary', () => {
  const files = walk('src');

  it('covers a meaningful file set (sanity)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    if (file.startsWith(ALLOWED_DIR) || ALLOWED_FILES.has(file)) continue;
    it(`${file}: @mastra/core value usage stays in src/mastra/**`, () => {
      expect(mastraValueViolations(file), `${file} uses @mastra/core values outside src/mastra/`).toEqual([]);
    });
  }
});
