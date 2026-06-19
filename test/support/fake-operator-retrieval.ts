import type { OperatorRetrievalPort, OperatorRetrievalInput } from '../../src/ports/operator-retrieval.port.ts';
import type { OperatorEvidence } from '../../src/domain/strategy-retrieval.ts';
import { sourceFingerprint } from '../../src/domain/fingerprint.ts';

/**
 * Deterministic OperatorRetrievalPort test double. Records every collect() input and
 * returns a fixed OperatorEvidence (default: complete, empty). Tests that want evidence
 * on the proposal/message pass a canned evidence object; the subjectHash defaults to the
 * message fingerprint when the canned evidence omits one.
 */
export class FakeOperatorRetrieval implements OperatorRetrievalPort {
  readonly calls: OperatorRetrievalInput[] = [];
  private readonly canned?: Partial<OperatorEvidence>;

  constructor(canned?: Partial<OperatorEvidence>) {
    this.canned = canned;
  }

  async collect(input: OperatorRetrievalInput): Promise<OperatorEvidence> {
    this.calls.push(input);
    const subjectHash = this.canned?.subjectHash ?? sourceFingerprint('manual_description', input.message.trim());
    return {
      subjectHash,
      status: this.canned?.status ?? 'complete',
      exactLookup: this.canned?.exactLookup ?? 'miss',
      ...(this.canned?.exactMatch ? { exactMatch: this.canned.exactMatch } : {}),
      similarStrategies: this.canned?.similarStrategies ?? [],
      evidenceRefs: this.canned?.evidenceRefs ?? [],
      warningCodes: this.canned?.warningCodes ?? [],
      timingsMs: this.canned?.timingsMs ?? { totalMs: 0 },
    };
  }
}
