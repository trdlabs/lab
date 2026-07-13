// src/orchestrator/handlers/platform-run-config.schema.ts
import { z } from 'zod';

/** The single canonical Zod shape for a PlatformRunConfig (the Cycle-2 eval window).
 *  Mirrors the PlatformRunConfig interface in ports/research-platform.port.ts. Shared by
 *  every payload schema that carries an eval window so the three sites never drift (R3b-1 §3.0). */
export const PlatformRunConfigSchema = z.object({
  datasetId: z.string().min(1),
  symbols: z.array(z.string().min(1)).min(1),
  timeframe: z.string().min(1),
  period: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  seed: z.number().int(),
});

export type PlatformRunConfigInput = z.infer<typeof PlatformRunConfigSchema>;
