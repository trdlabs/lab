import { describe, it, expect } from 'vitest';
import { gatherStrategyCode } from './strategy-code.ts';

describe('gatherStrategyCode', () => {
  it('sorts by name, prefixes a FILE header, joins with a blank line', () => {
    const out = gatherStrategyCode(
      [{ name: 'b.ts', content: 'B' }, { name: 'a.ts', content: 'A' }],
      { pathPrefix: 'src/strategies/long_oi' },
    );
    expect(out).toBe(
      '// ===== FILE: src/strategies/long_oi/a.ts =====\nA\n\n' +
      '// ===== FILE: src/strategies/long_oi/b.ts =====\nB',
    );
  });

  it('is deterministic and pure (no trailing newline)', () => {
    const files = [{ name: 'x.ts', content: 'x' }];
    expect(gatherStrategyCode(files, { pathPrefix: 'p' }))
      .toBe(gatherStrategyCode(files, { pathPrefix: 'p' }));
    expect(gatherStrategyCode(files, { pathPrefix: 'p' }).endsWith('\n')).toBe(false);
  });
});
