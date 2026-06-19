import { z } from 'zod';

export const SUBJECTS = ['strategy', 'bot', 'results', 'task', 'hypothesis', 'unknown'] as const;
export const TURN_GOALS = ['analyze', 'research', 'show_results', 'show_similar'] as const;

export const TurnInterpretationSchema = z.object({
  subject: z.enum(SUBJECTS),
  goal: z.enum(TURN_GOALS).optional(),
  strategyText: z.string().min(1).optional(),
  constraints: z.object({
    market: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    timeframe: z.string().min(1).optional(),
    direction: z.enum(['long', 'short', 'both']).optional(),
  }).strict(),
  references: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
}).strict();

export type InterpretedTurn = z.infer<typeof TurnInterpretationSchema>;
