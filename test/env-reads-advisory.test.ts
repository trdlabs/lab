import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  scanProcessEnvReads,
  SRC_PROCESS_ENV_ALLOWLIST,
  LITERAL_ONLY_FILES,
} from '../scripts/env-reads-advisory.ts';
import { envSchemaDocument } from '../src/config/env-schema.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('гейт «Полнота схемы»: process.env вне loadEnv (advisory)', () => {
  const hits = scanProcessEnvReads(repoRoot);
  const srcHits = hits.filter((h) => h.file.startsWith('src/'));

  it('в src/ (вне тестов) process.env читается только в явном allowlist-хвосте', () => {
    const offenders = srcHits.filter(
      (h) => !SRC_PROCESS_ENV_ALLOWLIST.has(h.file) && !LITERAL_ONLY_FILES.has(h.file),
    );
    expect(offenders).toEqual([]);
  });

  it('каждое литеральное имя, читаемое из src/-хвоста, объявлено в env-schema', () => {
    const declared = new Set(envSchemaDocument().variables.map((v) => v.name));
    const undeclared = srcHits.filter(
      (h) => h.name !== null && !LITERAL_ONLY_FILES.has(h.file) && !declared.has(h.name),
    );
    expect(undeclared).toEqual([]);
  });

  it('сканер видит и dot-, и bracket-доступ', () => {
    // report.ts делает process.env[requiredKey] — bracket-доступ без литерального имени
    expect(srcHits.some((h) => h.file === 'src/experiments/turn-interpreter/report.ts' && h.name === null)).toBe(true);
    expect(srcHits.some((h) => h.name === 'TRADE_CONTEXT_WARMUP_MIN')).toBe(true);
  });
});
