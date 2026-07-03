import type { SweepDesignerPort, SweepInput } from '../../ports/wfo-agents.port.ts';
import type { SweepDesignOutput } from '../../domain/wfo.ts';
import { classifyEntryAffectingParams } from '../../domain/wfo.ts';
import type { AgentCallOpts } from '../../ports/agent-call-opts.ts';

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export class FakeSweepDesigner implements SweepDesignerPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  readonly calls: SweepInput[] = [];

  async design(input: SweepInput, opts?: AgentCallOpts): Promise<SweepDesignOutput> {
    this.calls.push(input);
    if (opts?.onUsage) {
      await opts.onUsage({ modelId: this.model, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    }
    let candidates = input.tunableParams;
    if (input.restrictToEntryParams) {
      const { entryAffecting } = classifyEntryAffectingParams(input.tunableParams);
      candidates = input.tunableParams.filter((p) => entryAffecting.includes(p.name));
    }
    const picked = candidates.slice(0, 2);
    const grid: Record<string, unknown[]> = {};
    for (const param of picked) {
      const base = numericValue(param.value);
      grid[param.name] = base === undefined ? [param.value] : [base * 0.5, base * 1.5];
    }
    return {
      grid,
      rationale:
        picked.length === 0
          ? 'No eligible tunable params — empty grid.'
          : `Small grid over ${picked.map((p) => p.name).join(', ')} (±50% around baseline value).`,
    };
  }
}
