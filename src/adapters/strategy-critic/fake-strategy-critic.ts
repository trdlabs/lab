import type { StrategyCriticPort, AgentCallOpts } from '../../ports/strategy-critic.port.ts';
import type { StrategyCriticInput, StrategyRefinement } from '../../domain/strategy-critic.ts';

export class FakeStrategyCritic implements StrategyCriticPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  readonly mode: 'single' | 'two_stage';

  constructor(mode: 'single' | 'two_stage' = 'two_stage') {
    this.mode = mode;
  }

  async refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement> {
    await opts?.onUsage?.({ modelId: 'fake', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    return {
      vulnerabilities: ['fake-critic: no real critique performed'],
      selfDeception: [],
      risks: { market: 'n/a', timing: 'n/a', news: 'n/a', liquidity: 'n/a', btcRegime: 'n/a', exhaustion: 'n/a' },
      earlyBreakSigns: [],
      preEntryChecks: [],
      verdict: { mainVulnerability: 'none (fake)', severity: 'low', badIdeaOrBadTiming: 'neither', whatWouldStrengthen: 'n/a' },
      improvedStrategyText: input.content,
      changeLog: [],
    };
  }
}
