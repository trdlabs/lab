import { z } from 'zod';
import type { ArtifactRef } from './types.ts';
import type { SourceKind } from './strategy-source.ts';

export const DIRECTIONS = ['long', 'short', 'both', 'unknown'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const StrategyParameterSchema = z.object({
  name: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).nullable().default(null),
  unit: z.string().nullable().default(null),
  description: z.string(),
  tunable: z.boolean(),
});
export type StrategyParameter = z.infer<typeof StrategyParameterSchema>;

export const AnalystProfileOutputSchema = z.object({
  direction: z.enum(DIRECTIONS).describe('Net directional bias of the strategy'),
  coreIdea: z.string().min(1).describe('1-2 sentence core thesis'),
  summary: z.string().describe('Fuller description of how the strategy works'),
  requiredMarketFeatures: z.array(z.string()).describe('Market features needed, e.g. oi, funding, cvd'),
  entryConditions: z.array(z.string()),
  exitConditions: z.array(z.string()),
  timeframes: z.array(z.string()).describe('Timeframes used, e.g. 5m, 1h'),
  indicators: z.array(z.string()),
  parameters: z.array(StrategyParameterSchema),
  watchLifecycleSummary: z.string().nullable().default(null),
  positionManagementSummary: z.string().nullable().default(null),
  riskManagementSummary: z.string().nullable().default(null),
  runnerOwnedAuthorities: z.array(z.string()).describe('Concerns owned by runner/platform: risk sizing, fills, execution'),
  confidence: z.number().min(0).max(1),
  unknowns: z.array(z.string()),
  evidence: z.array(z.string()).describe('Quotes/refs from the source supporting the profile'),
});
export type AnalystProfileOutput = z.infer<typeof AnalystProfileOutputSchema>;

export const STRATEGY_PROFILE_CONTRACT_VERSION = 'strategy-profile-v1';

export interface StrategyProfile {
  id: string;
  version: number;
  sourceKind: SourceKind;
  sourceFingerprint: string;
  direction: Direction;
  coreIdea: string;
  requiredMarketFeatures: string[];
  confidence: number;
  unknowns: string[];
  profile: AnalystProfileOutput;
  sourceArtifactRef: ArtifactRef;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}
