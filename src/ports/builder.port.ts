// src/ports/builder.port.ts
import { z } from 'zod';
import { ModuleManifestSchema } from '../domain/module-bundle.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';

/** Optional per-call hooks. onUsage reports the LLM token usage of this call (0 when unknown). */
export interface AgentCallOpts {
  onUsage?: (totalTokens: number) => void | Promise<void>;
}

export interface BuilderInput {
  hypothesis: HypothesisProposal;
  profile: StrategyProfile;
  sdkDoc: string;
}

/** Strict: an LLM cannot smuggle extra trusted fields (e.g. a bundleHash). */
export const BuilderOutputSchema = z.object({
  manifest: ModuleManifestSchema,
  files: z.record(z.string()),
  notes: z.string().optional(),
}).strict();
export type BuilderOutput = z.infer<typeof BuilderOutputSchema>;

export interface BuilderPort {
  readonly adapter: string;
  readonly model: string;
  build(input: BuilderInput, opts?: AgentCallOpts): Promise<BuilderOutput>;
}
