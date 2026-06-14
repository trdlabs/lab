import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { BUILDER_SDK_DOC } from '../../adapters/builder/builder-sdk-doc.ts';

export const BUILDER_AGENT_ID = 'builder';

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

export function createBuilderAgent(model: ProviderModel): Agent {
  return new Agent({ id: BUILDER_AGENT_ID, name: 'Builder', instructions: INSTRUCTIONS, model });
}
