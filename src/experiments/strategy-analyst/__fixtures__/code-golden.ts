import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalystProfileOutputSchema, type AnalystProfileOutput } from '../../../domain/strategy-profile.ts';

const JSON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../adapters/builder/fixtures/long-oi-profile.json',
);
const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { profile: unknown };

/** The code-derived long_oi analyst profile (sourceKind bot_code, conf 0.99). The golden reference
 *  for golden-role eval consumers. Validated at import — throws if long-oi-profile.json drifts. */
export const CODE_LONG_OI_PROFILE: AnalystProfileOutput = AnalystProfileOutputSchema.parse(raw.profile);
