import { describe, expect, it } from 'vitest';
import { resolveConfirmationReply } from './confirmation-resolver.ts';

describe('resolveConfirmationReply', () => {
  it.each(['да', 'подтверждаю', 'подтвердить анализ', '1'])('confirms %s', (message) => {
    expect(resolveConfirmationReply(message)).toBe('confirm');
  });

  it.each(['нет', 'отмена', 'отменить'])('cancels %s', (message) => {
    expect(resolveConfirmationReply(message)).toBe('cancel');
  });

  it.each(['покажи похожие', 'другая стратегия', 'может быть'])('does not guess for %s', (message) => {
    expect(resolveConfirmationReply(message)).toBe('unresolved');
  });

  // Normalization: whitespace and case
  it('confirms " Да " (leading/trailing whitespace)', () => {
    expect(resolveConfirmationReply(' Да ')).toBe('confirm');
  });

  it('confirms "ПОДТВЕРЖДАЮ" (uppercase)', () => {
    expect(resolveConfirmationReply('ПОДТВЕРЖДАЮ')).toBe('confirm');
  });

  // Guard against substring matching: "дать стратегию" contains "да" but must NOT match
  it('returns unresolved for "дать стратегию" (contains "да" as substring)', () => {
    expect(resolveConfirmationReply('дать стратегию')).toBe('unresolved');
  });
});
