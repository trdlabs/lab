import { z } from 'zod';
import { StrategyAnalystInputSchema } from './strategy-source.ts';

/** The critic sees exactly what the analyst would — reuse the analyst input shape. */
export const StrategyCriticInputSchema = StrategyAnalystInputSchema;
export type StrategyCriticInput = z.infer<typeof StrategyCriticInputSchema>;

/** The 6-section human-facing critique, mirroring the ruthless-market-opponent prompt. */
export const StrategyCritiqueSchema = z.object({
  vulnerabilities: z.array(z.string()),
  selfDeception: z.array(z.string()),
  risks: z.object({
    market: z.string(),
    timing: z.string(),
    news: z.string(),
    liquidity: z.string(),
    btcRegime: z.string(),
    exhaustion: z.string(),
  }),
  earlyBreakSigns: z.array(z.string()),
  preEntryChecks: z.array(z.string()),
  verdict: z.object({
    mainVulnerability: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    badIdeaOrBadTiming: z.enum(['bad_idea', 'bad_timing', 'neither']),
    whatWouldStrengthen: z.string(),
  }),
});
export type StrategyCritique = z.infer<typeof StrategyCritiqueSchema>;

/** The port's return type — `improvedStrategyText` is what the analyst receives. */
export const StrategyRefinementSchema = StrategyCritiqueSchema.extend({
  improvedStrategyText: z.string(),
  changeLog: z.array(z.string()),
});
export type StrategyRefinement = z.infer<typeof StrategyRefinementSchema>;
