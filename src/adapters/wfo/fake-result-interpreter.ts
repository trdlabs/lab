import type { ResultInterpreterPort, InterpretInput } from '../../ports/wfo-agents.port.ts';
import type { ResultInterpretOutput } from '../../domain/wfo.ts';

export class FakeResultInterpreter implements ResultInterpreterPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';

  async interpret(input: InterpretInput): Promise<ResultInterpretOutput> {
    if (input.topN.length === 0) {
      return { decision: 'stop' };
    }
    return { decision: 'select', chosenParamsHash: input.topN[0]!.paramsHash };
  }
}
