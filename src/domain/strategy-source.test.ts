import { describe, it, expect } from 'vitest';
import { StrategyAnalystInputSchema, SOURCE_KINDS } from './strategy-source.ts';

describe('StrategyAnalystInputSchema', () => {
  it('accepts a valid bot_code input', () => {
    const r = StrategyAnalystInputSchema.safeParse({ kind: 'bot_code', content: 'def run(): pass' });
    expect(r.success).toBe(true);
  });
  it('rejects an unknown kind', () => {
    expect(StrategyAnalystInputSchema.safeParse({ kind: 'tweet', content: 'x' }).success).toBe(false);
  });
  it('rejects empty content', () => {
    expect(StrategyAnalystInputSchema.safeParse({ kind: 'article', content: '' }).success).toBe(false);
  });
  it('exposes the six source kinds', () => {
    expect(SOURCE_KINDS).toEqual(['bot_code', 'readme', 'article', 'notebooklm_summary', 'manual_description', 'crawler']);
  });
});
