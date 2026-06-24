import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import type { BuilderInput, BuilderOutput, BuilderPort, AgentCallOpts } from '../../ports/builder.port.ts';
import { BuilderOutputSchema } from '../../ports/builder.port.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { DIRECTIONS } from '../../domain/strategy-profile.ts';

/**
 * LLM-compatible schema:
 * - z.nullable() on optional strings keeps them in JSON Schema `required` (strict-mode OpenAI).
 * - `files` uses an array of {name, content} instead of z.record() because OpenAI strict-mode
 *   rejects `additionalProperties`-based schemas. Converted to Record<string,string> in domain.
 */
const LlmBuilderOutputSchema = z.object({
  manifest: z.object({
    moduleId: z.string().min(1),
    moduleKind: z.literal('hypothesis_overlay'),
    appliesTo: z.enum(DIRECTIONS),
    entry: z.string().min(1),
    exports: z.array(z.string().min(1)).min(1),
    capabilities: z.array(z.string()),
    sdkContractVersion: z.string().min(1),
  }),
  files: z.array(z.object({ name: z.string().min(1), content: z.string() })).min(1),
  notes: z.string().nullable(),
});

type LlmBuilderOutput = z.infer<typeof LlmBuilderOutputSchema>;

function llmOutputToDomain(raw: LlmBuilderOutput): BuilderOutput {
  const filesRecord: Record<string, string> = {};
  for (const f of raw.files) filesRecord[f.name] = f.content;
  return BuilderOutputSchema.parse({
    manifest: raw.manifest,
    files: filesRecord,
    ...(raw.notes !== null ? { notes: raw.notes } : {}),
  });
}

export function buildPromptFor(input: BuilderInput): string {
  const { hypothesis, profile, sdkDoc } = input ?? {};
  return [
    '=== TASK ===',
    'Build a hypothesis overlay module for the following validated hypothesis.',
    '',
    '=== HYPOTHESIS ===',
    `Thesis: ${hypothesis?.thesis}`,
    `Target behavior: ${hypothesis?.targetBehavior}`,
    `Applies to: ${hypothesis?.ruleAction?.appliesTo}`,
    `Rules from hypothesis: ${JSON.stringify(hypothesis?.ruleAction?.rules, null, 2)}`,
    `Required features (allowed capabilities for manifest): ${hypothesis?.requiredFeatures?.join(', ')}`,
    `Expected effect: ${hypothesis?.expectedEffect?.metric} should ${hypothesis?.expectedEffect?.direction}`,
    '',
    '=== STRATEGY PROFILE ===',
    `Strategy direction: ${profile?.direction}`,
    `Market features: ${profile?.requiredMarketFeatures?.join(', ')}`,
    '',
    '=== REQUIREMENTS ===',
    `- manifest.moduleId: "overlay-${hypothesis?.id}"`,
    '- manifest.moduleKind: "hypothesis_overlay"',
    `- manifest.appliesTo: "${hypothesis?.ruleAction?.appliesTo}"`,
    '- manifest.entry: "index.ts"',
    '- manifest.exports: ["overlay"]',
    `- manifest.capabilities: only features from requiredFeatures (${hypothesis?.requiredFeatures?.join(', ')})`,
    `- manifest.sdkContractVersion: "${SDK_CONTRACT_VERSION}"`,
    '- files: array of {name, content} objects. MUST include {name:"index.ts", content:"..."} with the overlay export',
    '- No imports, no process.env, no eval, no fetch — pure data/logic only',
    '',
    '=== SDK REFERENCE ===',
    sdkDoc,
  ].join('\n');
}

export class MastraBuilder implements BuilderPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async build(input: BuilderInput, opts?: AgentCallOpts): Promise<BuilderOutput> {
    const result = await this.agent.generate(buildPromptFor(input), {
      structuredOutput: { schema: LlmBuilderOutputSchema },
    });
    await opts?.onUsage?.(result.usage?.totalTokens ?? 0);
    const raw = LlmBuilderOutputSchema.parse(result.object);
    return llmOutputToDomain(raw);
  }
}
