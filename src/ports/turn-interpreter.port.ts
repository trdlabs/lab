/**
 * Advisory turn interpreter. `interpret` returns `unknown` on purpose: the caller's schema gate
 * (TurnInterpretationSchema) is the single trust boundary after normalizeTurnOutput strips nulls.
 * The interpreter has no tools, performs no side effects, and reads no secrets.
 */
export interface TurnInterpreterPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  interpret(message: string): Promise<unknown>; // returns RAW provider output (untrusted)
}
