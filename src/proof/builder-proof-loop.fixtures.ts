import type { StrategyBuilder, StrategyBuilderInput, StrategyBuilderOutput, StrategyManifestMeta } from '../ports/strategy-builder.port.ts';

// Источник с ambient-доступом → validateStrategyBundle вернёт status:'rejected'.
// Паттерн `process.env` совпадает с `process_access` (id в AMBIENT_PATTERNS),
// поэтому verdict.violations = ['process_access'], а reason = 'forbidden_ambient_authority'.
const AMBIENT_SOURCE =
  'export default function createStrategyModule(){ const s = process.env.SECRET; return { init(){}, onBarClose(){ return s; } }; }';

const AMBIENT_META: StrategyManifestMeta = {
  id: 'ambient_x', version: '0.1.0', name: 'Ambient', summary: 's', rationale: 'r',
  paramsSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  capabilities: { platformSdk: true }, dataNeeds: { closedCandlesUpToCurrent: true }, hooks: ['onBarClose'],
};

export class AmbientBuilder implements StrategyBuilder {
  readonly adapter = 'ambient';
  readonly model = 'ambient';
  async build(_i: StrategyBuilderInput): Promise<StrategyBuilderOutput> {
    return { source: AMBIENT_SOURCE, manifestMeta: AMBIENT_META };
  }
}
