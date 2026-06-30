import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherStrategyCode } from '../../../domain/strategy-code.ts';
import { sourceFingerprint } from '../../../domain/fingerprint.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_DIR = join(HERE, '../../../../docs/fixtures/strategies/long-oi-code');
const GOLDEN = join(HERE, '../../../adapters/builder/fixtures/long-oi-profile.json');

describe('long-oi vendored code fingerprint', () => {
  it('gathered vendor code reproduces the golden sourceFingerprint', () => {
    const files = readdirSync(CODE_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((name) => ({ name, content: readFileSync(join(CODE_DIR, name), 'utf8') }));
    const gathered = gatherStrategyCode(files, { pathPrefix: 'src/strategies/long_oi' });
    const fp = sourceFingerprint('bot_code', gathered);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { sourceFingerprint: string };
    expect(fp).toBe(golden.sourceFingerprint);
    expect(fp).toBe('sha256:2bdc5389969657cd46ec2500022350e768a0426d8d7bcbb01b14f344157f82b5');
  });
});
