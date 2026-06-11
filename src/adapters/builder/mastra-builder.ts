// src/adapters/builder/mastra-builder.ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../llm/model-provider.ts';
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import { BuilderOutputSchema } from '../../ports/builder.port.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { BUILDER_SDK_DOC } from './builder-sdk-doc.ts';

const INSTRUCTIONS = [
  'You are a module builder for a research-only trading lab.',
  'Given a validated hypothesis, emit a hypothesis_overlay ModuleBundle draft (manifest + files).',
  'The entry file MUST export a const named `overlay`. Use NO imports, NO network, NO filesystem,',
  'NO process access, NO eval. Pure data and logic only. This code is never executed in the lab.',
  `Set manifest.sdkContractVersion to '${SDK_CONTRACT_VERSION}' and manifest.moduleKind to 'hypothesis_overlay'.`,
  'Declare only capabilities that appear in the hypothesis required features.',
  'Do NOT include a bundleHash — the lab computes it.',
  `SDK reference:\n${BUILDER_SDK_DOC}`,
].join(' ');

function buildPrompt(input: BuilderInput): string {
  return [
    `Hypothesis thesis: ${input.hypothesis.thesis}`,
    `Applies to: ${input.hypothesis.ruleAction.appliesTo}`,
    `Rules: ${JSON.stringify(input.hypothesis.ruleAction.rules)}`,
    `Required features (allowed capabilities): ${input.hypothesis.requiredFeatures.join(', ')}`,
    'Produce manifest.entry = "index.ts" and manifest.exports = ["overlay"].',
  ].join('\n');
}

export class MastraBuilder implements BuilderPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: ProviderModel, label: string) {
    this.model = label;
    this.agent = new Agent({ id: 'builder', name: 'Builder', instructions: INSTRUCTIONS, model });
  }

  async build(input: BuilderInput): Promise<BuilderOutput> {
    const result = await this.agent.generate(buildPrompt(input), { structuredOutput: { schema: BuilderOutputSchema } });
    return BuilderOutputSchema.parse(result.object);
  }
}
