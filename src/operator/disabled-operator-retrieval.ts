// src/operator/disabled-operator-retrieval.ts
import type { OperatorEvidence } from '../domain/strategy-retrieval.ts';
import type {
  OperatorRetrievalInput,
  OperatorRetrievalPort,
} from '../ports/operator-retrieval.port.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import type { EmbeddingPort } from '../ports/embedding.port.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { StrategySimilarityPort } from '../ports/strategy-similarity.port.ts';

/**
 * Dependencies are accepted only so the disabled adapter is a drop-in for the real one;
 * NONE of them are ever invoked. `collect()` performs zero I/O.
 */
export interface DisabledOperatorRetrievalDeps {
  embedding?: EmbeddingPort;
  strategyProfiles?: StrategyProfileRepository;
  similarity?: StrategySimilarityPort;
}

/**
 * Null-object OperatorRetrievalPort for when RAG retrieval is switched off.
 * Returns a deterministic, authoritative-absence-free evidence record: status
 * `disabled`, exactLookup `not_run`, and empty candidates/refs/warnings. The only
 * computed field is the subjectHash, derived from the message so downstream audit
 * trails still carry a stable subject identity without any retrieval.
 */
export class DisabledOperatorRetrieval implements OperatorRetrievalPort {
  // Held purely to keep parity with the enabled constructor; intentionally unused.
  readonly #deps: DisabledOperatorRetrievalDeps;

  constructor(deps: DisabledOperatorRetrievalDeps = {}) {
    this.#deps = deps;
  }

  async collect(input: OperatorRetrievalInput): Promise<OperatorEvidence> {
    void this.#deps; // explicitly never touched
    return {
      subjectHash: sourceFingerprint('manual_description', input.message.trim()),
      status: 'disabled',
      exactLookup: 'not_run',
      similarStrategies: [],
      evidenceRefs: [],
      warningCodes: [],
      timingsMs: {},
    };
  }
}
