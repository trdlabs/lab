import { describe, it, expect } from 'vitest';
import { SHORT_AFTER_PUMP_SOURCE } from './short-after-pump.strategy-source.js';

describe('stand-in source', () => {
  it('is self-contained ESM createStrategyModule', () => {
    expect(SHORT_AFTER_PUMP_SOURCE).toContain('export default');
    expect(SHORT_AFTER_PUMP_SOURCE).toContain('createStrategyModule');
    const stripped = SHORT_AFTER_PUMP_SOURCE.replace(/export\s+default/g, '');
    expect(/\b(import|require)\s*[(.]|\bfrom\s+['"]/.test(stripped)).toBe(false);
  });
});
