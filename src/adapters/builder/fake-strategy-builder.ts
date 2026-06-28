import type { StrategyBuilder, StrategyBuilderInput, StrategyBuilderOutput, StrategyManifestMeta } from '../../ports/strategy-builder.port.ts';
import type { AgentCallOpts } from '../../ports/agent-call-opts.ts';
import { SHORT_AFTER_PUMP_SOURCE } from './fixtures/short-after-pump.strategy-source.ts';

const SHORT_AFTER_PUMP_META: StrategyManifestMeta = {
  id: 'short_after_pump',
  version: '0.1.0',
  name: 'Short after pump',
  summary: 'Шорт после резкого роста цены при достаточном объёме',
  rationale: 'Резкий памп без фундаментала часто откатывает; вход в шорт по подтверждённому росту.',
  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['pumpPct', 'windowMin', 'minVolume'],
    properties: {
      pumpPct: { type: 'number' },
      windowMin: { type: 'number' },
      minVolume: { type: 'number' },
    },
  },
  params: { pumpPct: 10, windowMin: 20, minVolume: 1000000 },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true },
  hooks: ['onBarClose'],
};

export class FakeStrategyBuilder implements StrategyBuilder {
  readonly adapter = 'fake';
  readonly model = 'fake';

  async build(_i: StrategyBuilderInput, _opts?: AgentCallOpts): Promise<StrategyBuilderOutput> {
    return { source: SHORT_AFTER_PUMP_SOURCE, manifestMeta: SHORT_AFTER_PUMP_META };
  }
}
