import type { StrategyConsolidatorPort, StrategyConsolidateArgs } from '../../ports/strategy-consolidator.port.ts';
import type { StrategyBuilderOutput } from '../../ports/strategy-builder.port.ts';
import { SHORT_AFTER_PUMP_SOURCE, SHORT_AFTER_PUMP_META } from '../builder/fake-strategy-builder.ts';

export class FakeStrategyConsolidator implements StrategyConsolidatorPort {
  readonly adapter = 'fake';
  readonly model = 'fake';

  async consolidate(args: StrategyConsolidateArgs): Promise<StrategyBuilderOutput> {
    return { source: SHORT_AFTER_PUMP_SOURCE, manifestMeta: args.manifestMeta ?? SHORT_AFTER_PUMP_META };
  }
}
