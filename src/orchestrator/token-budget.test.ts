import { describe, it, expect } from 'vitest';
import { withinTokenBudget } from './token-budget.ts';

describe('withinTokenBudget', () => {
  it('is within budget below the limit', () => {
    expect(withinTokenBudget(100, 200)).toBe(true);
  });
  it('is over budget at or above the limit', () => {
    expect(withinTokenBudget(200, 200)).toBe(false);
    expect(withinTokenBudget(201, 200)).toBe(false);
  });
  it('treats budget 0 (or negative) as unlimited', () => {
    expect(withinTokenBudget(1_000_000, 0)).toBe(true);
    expect(withinTokenBudget(1_000_000, -5)).toBe(true);
  });
});
