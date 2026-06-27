// src/experiments/strategy-critic/plan.ts
import { parseRoleModel, MODEL_PROVIDERS, type ModelProvider, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import type { Candidate } from './types.ts';

export const KEY_BY_PROVIDER: Record<ModelProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export interface DryRunCandidatePlan {
  label: string;
  mode: 'single' | 'two_stage';
  models: string[];    // distinct role models this candidate uses
  callsPerRun: number; // model calls per (case × repeat): single=1, two_stage=2
}

export interface DryRunPlan {
  repeat: number;
  caseCount: number;
  perCandidate: DryRunCandidatePlan[];
  refineCalls: number;
  judgeCalls: number;
  analystCalls: number; // candidates × cases × repeat when roundTrip, else 0
  totalPaidCalls: number;
  missingKeys: string[];
}

export interface PlanInput {
  candidates: Candidate[];
  cases: string[]; // case ids
  judge: boolean;
  judgeModel?: string;
  env: Record<string, string | undefined>;
  repeat?: number;
  roundTrip?: boolean;
  analystModel?: string;
}

function rolesOf(c: Candidate): string[] {
  return c.mode === 'single' ? [c.combinedModel] : [c.criticModel, c.refinerModel];
}

function isProvider(value: string | undefined): value is ModelProvider {
  return value != null && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export function planDryRun(input: PlanInput): DryRunPlan {
  const repeat = input.repeat ?? 1;
  const caseCount = input.cases.length;
  const modelEnv: ModelProviderEnv = { MODEL_PROVIDER: input.env.MODEL_PROVIDER as ModelProvider };

  const perCandidate: DryRunCandidatePlan[] = input.candidates.map((c) => {
    const models = rolesOf(c);
    return { label: c.label, mode: c.mode, models, callsPerRun: models.length };
  });

  const refineCalls = perCandidate.reduce((s, p) => s + p.callsPerRun, 0) * caseCount * repeat;
  const judgeCalls = (input.judge ? input.candidates.length : 0) * caseCount * repeat;
  const analystCalls = input.roundTrip ? input.candidates.length * caseCount * repeat : 0;

  const allModels = new Set<string>();
  for (const p of perCandidate) for (const m of p.models) allModels.add(m);
  if (input.judge && input.judgeModel) allModels.add(input.judgeModel);
  if (input.roundTrip && input.analystModel) allModels.add(input.analystModel);

  const missing = new Set<string>();
  for (const m of allModels) {
    const { provider } = parseRoleModel(modelEnv, m);
    if (!isProvider(provider)) continue;
    const key = KEY_BY_PROVIDER[provider];
    if (!input.env[key]) missing.add(key);
  }

  return { repeat, caseCount, perCandidate, refineCalls, judgeCalls, analystCalls, totalPaidCalls: refineCalls + judgeCalls + analystCalls, missingKeys: [...missing] };
}
