import { describe, it, expect } from 'vitest';
import { buildCodeSource } from './code-source.ts';

describe('buildCodeSource', () => {
  it('single file → FILE marker + content', () => {
    expect(buildCodeSource([{ path: 'a.ts', content: 'const x = 1;' }]))
      .toBe('// ===== FILE: a.ts =====\nconst x = 1;');
  });
  it('multiple files → markers in caller order, blank-line separated', () => {
    expect(buildCodeSource([{ path: 'a.ts', content: 'A' }, { path: 'b.ts', content: 'B' }]))
      .toBe('// ===== FILE: a.ts =====\nA\n\n// ===== FILE: b.ts =====\nB');
  });
  it('preserves caller order (no internal sort)', () => {
    const s = buildCodeSource([{ path: 'z.ts', content: 'Z' }, { path: 'a.ts', content: 'A' }]);
    expect(s.indexOf('z.ts')).toBeLessThan(s.indexOf('a.ts'));
  });
  it('empty list → empty string', () => {
    expect(buildCodeSource([])).toBe('');
  });
});
