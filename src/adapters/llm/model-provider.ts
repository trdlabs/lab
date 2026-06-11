// src/adapters/llm/model-provider.ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export const MODEL_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelProviderEnv {
  MODEL_PROVIDER: ModelProvider;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

const OVERRIDE_PREFIXES = new Set<string>(MODEL_PROVIDERS);

/** First path segment is a provider override ONLY when it's exactly anthropic|openai|openrouter;
 *  otherwise the whole id falls through to the global MODEL_PROVIDER. */
export function parseRoleModel(env: ModelProviderEnv, roleModelId: string): { provider: ModelProvider; modelId: string } {
  const slash = roleModelId.indexOf('/');
  if (slash > 0) {
    const head = roleModelId.slice(0, slash);
    if (OVERRIDE_PREFIXES.has(head)) {
      return { provider: head as ModelProvider, modelId: roleModelId.slice(slash + 1) };
    }
  }
  return { provider: env.MODEL_PROVIDER, modelId: roleModelId };
}

// Canonical model type. The Task-1 probe confirmed all three providers' returns are assignable to this.
export type ProviderModel = ReturnType<ReturnType<typeof createAnthropic>>;

export interface ResolvedModel {
  model: ProviderModel;
  provider: ModelProvider;
  modelId: string;
  label: string; // original role model env value, for audit
}

export function resolveLanguageModel(env: ModelProviderEnv, roleModelId: string): ResolvedModel {
  const { provider, modelId } = parseRoleModel(env, roleModelId);
  let model: ProviderModel;
  switch (provider) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for MODEL provider "anthropic"');
      model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId);
      break;
    case 'openai':
      if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for MODEL provider "openai"');
      model = createOpenAI({ apiKey: env.OPENAI_API_KEY })(modelId);
      break;
    case 'openrouter':
      if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for MODEL provider "openrouter"');
      model = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(modelId);
      break;
    default: {
      const _x: never = provider;
      throw new Error(`unknown provider: ${String(_x)}`);
    }
  }
  return { model, provider, modelId, label: roleModelId };
}
