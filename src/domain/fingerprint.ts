import { createHash } from 'node:crypto';
import type { SourceKind } from './strategy-source.ts';

/**
 * Canonicalize source content for stable hashing: CR/CRLF -> LF, Unicode NFC, trim.
 * Internal whitespace is preserved on purpose - collapsing it would create false
 * fingerprint matches for bot_code.
 */
export function canonicalizeContent(content: string): string {
  return content.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

export function sourceFingerprint(kind: SourceKind, content: string): string {
  const canonical = canonicalizeContent(content);
  const sep = String.fromCharCode(32); // space separator
  const hex = createHash('sha256').update(`${kind}${sep}${canonical}`, 'utf8').digest('hex');
  return `sha256:${hex}`;
}
