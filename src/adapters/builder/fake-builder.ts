// src/adapters/builder/fake-builder.ts
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { normalizeFeature } from '../../domain/hypothesis-rules.ts';

/** Deterministic stub: templates a clean overlay module from the hypothesis ruleAction.
 *  Emits no imports / denylist tokens, so it always passes the Build Validator. No network. */
export class FakeBuilder implements BuilderPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';

  async build(input: BuilderInput): Promise<BuilderOutput> {
    const { hypothesis } = input;
    const overlay = { appliesTo: hypothesis.ruleAction.appliesTo, rules: hypothesis.ruleAction.rules };
    const source = `export const overlay = ${JSON.stringify(overlay)};\n`;
    return {
      manifest: {
        moduleId: `overlay-${hypothesis.id}`,
        moduleKind: 'hypothesis_overlay',
        appliesTo: hypothesis.ruleAction.appliesTo,
        entry: 'index.ts',
        exports: ['overlay'],
        capabilities: hypothesis.requiredFeatures.map(normalizeFeature),
        sdkContractVersion: SDK_CONTRACT_VERSION,
      },
      files: { 'index.ts': source },
      notes: 'fake builder template',
    };
  }
}
