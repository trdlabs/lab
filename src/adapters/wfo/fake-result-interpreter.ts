import type { ResultInterpreterPort, InterpretInput } from '../../ports/wfo-agents.port.ts';
import type { ResultInterpretOutput } from '../../domain/wfo.ts';
import type { AgentCallOpts } from '../../ports/agent-call-opts.ts';

export class FakeResultInterpreter implements ResultInterpreterPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  readonly calls: InterpretInput[] = [];

  async interpret(input: InterpretInput, opts?: AgentCallOpts): Promise<ResultInterpretOutput> {
    this.calls.push(input);
    if (opts?.onUsage) {
      await opts.onUsage({ modelId: this.model, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    }
    if (input.topN.length === 0) {
      return { decision: 'stop' };
    }
    return { decision: 'select', chosenParamsHash: input.topN[0]!.paramsHash };
  }
}
