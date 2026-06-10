import { describe, it, expect } from 'vitest';
import { sourceFingerprint, canonicalizeContent } from './fingerprint.ts';

describe('sourceFingerprint', () => {
  it('returns sha256:<64hex>', () => {
    expect(sourceFingerprint('article', 'hello')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('is stable across CRLF vs LF and surrounding whitespace', () => {
    expect(sourceFingerprint('bot_code', '  a\r\nb  ')).toBe(sourceFingerprint('bot_code', 'a\nb'));
  });
  it('differs when sourceKind differs for identical content', () => {
    expect(sourceFingerprint('article', 'same')).not.toBe(sourceFingerprint('readme', 'same'));
  });
  it('does NOT collapse internal whitespace (bot_code stays distinct)', () => {
    expect(sourceFingerprint('bot_code', 'a  b')).not.toBe(sourceFingerprint('bot_code', 'a b'));
  });
});

describe('canonicalizeContent', () => {
  it('normalizes CRLF to LF and trims', () => {
    expect(canonicalizeContent('  x\r\ny  ')).toBe('x\ny');
  });
});
