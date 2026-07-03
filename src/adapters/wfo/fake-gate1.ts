import type { Gate1DecisionPort } from '../../ports/wfo-agents.port.ts';
import type { Gate1Input } from '../../ports/wfo-agents.port.ts';
import type { Gate1Output } from '../../domain/wfo.ts';
import type { AgentCallOpts } from '../../ports/agent-call-opts.ts';

export class FakeGate1 implements Gate1DecisionPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  readonly calls: Gate1Input[] = [];

  async decide(input: Gate1Input, opts?: AgentCallOpts): Promise<Gate1Output> {
    this.calls.push(input);
    if (opts?.onUsage) {
      await opts.onUsage({ modelId: this.model, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    }
    if (input.baselineMetrics.totalTrades >= 1) {
      return { decision: 'improve', reason: 'Baseline has trades — improvement round is worth running.' };
    }
    if (input.entryAffecting.length > 0 && input.hasEntrySignalEvidence === true) {
      return {
        decision: 'allow_exploratory_sweep',
        reason: 'Zero-trade baseline, but entry-affecting tunables exist and entry-signal evidence supports an exploratory sweep.',
      };
    }
    return {
      decision: 'stop_insufficient_evidence',
      reason: 'Zero-trade baseline without both entry-affecting tunables and entry-signal evidence — not enough basis to sweep.',
    };
  }
}
