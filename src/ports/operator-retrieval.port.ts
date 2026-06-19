// src/ports/operator-retrieval.port.ts
import type { OperatorEvidence } from '../domain/strategy-retrieval.ts';
import type { InterpretedTurn } from '../chat/turn-interpretation.ts';

export interface OperatorRetrievalInput {
  turn: InterpretedTurn;
  message: string;
  sessionId: string;
  retrievalId: string;
}

/**
 * Gathers operator-facing evidence for an interpreted turn.
 *
 * Implementations MUST NOT place raw strategy text, embeddings, or secrets in the
 * returned evidence — only hashes, ids, counts, codes, and timings.
 */
export interface OperatorRetrievalPort {
  collect(input: OperatorRetrievalInput): Promise<OperatorEvidence>;
}
