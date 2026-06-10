import { z } from 'zod';

export const SOURCE_KINDS = [
  'bot_code', 'readme', 'article', 'notebooklm_summary', 'manual_description', 'crawler',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const StrategyAnalystInputSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  content: z.string().min(1),
  uri: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});
export type StrategyAnalystInput = z.infer<typeof StrategyAnalystInputSchema>;
