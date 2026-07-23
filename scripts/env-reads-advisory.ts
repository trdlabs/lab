// `pnpm env:reads` — advisory-скан прямых чтений process.env (env-catalog item 4,
// гейт «Полнота схемы» в advisory-режиме).
//
// Правила:
// - src/ (вне тестов): чтение process.env допустимо только в файлах из
//   SRC_PROCESS_ENV_ALLOWLIST (loadEnv + задокументированный хвост, см. roadmap
//   env-catalog) — всё прочее ошибка (exit 1); пинуется test/env-reads-advisory.test.ts;
// - scripts/: CLI-инструменты читают env напрямую — печатаем имена, не объявленные
//   в env-схеме, как предупреждение; с флагом --strict это тоже ошибка.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EnvReadHit {
  /** repo-относительный путь */
  file: string;
  line: number;
  /** Литеральное имя переменной; null для динамического bracket-доступа. */
  name: string | null;
}

/** Файлы src/, которым разрешено читать process.env (единая точка + задокументированный хвост). */
export const SRC_PROCESS_ENV_ALLOWLIST = new Set<string>([
  'src/config/env.ts', // единственная штатная точка чтения (loadEnv)
  'src/adapters/platform/select-run-trades.ts', // хвост: BACKTESTER_API_URL/TOKEN, объявлены в схеме
  'src/adapters/platform/select-research-platform.ts', // хвост: BACKTESTER_API_URL/TOKEN, объявлены в схеме
  'src/orchestrator/handlers/research-run-cycle.handler.ts', // хвост: TRADE_CONTEXT_*/MARKET_HISTORY_*/RESEARCHER_MAX_PER_PASS
  'src/experiments/turn-interpreter/report.ts', // хвост: MODEL_PROVIDER + динамическая проверка наличия ключа
]);

/** Файлы, где `process.env` встречается только внутри строковых литералов/фикстур. */
export const LITERAL_ONLY_FILES = new Set<string>([
  'src/proof/builder-proof-loop.fixtures.ts',
]);

const READ_PATTERN = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[)/g;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(ts|mts)$/.test(entry) && !/\.test\.(ts|mts)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

/** Сканирует src/ и scripts/ на чтения process.env (dot- и bracket-доступ), тесты исключены. */
export function scanProcessEnvReads(repoRoot: string): EnvReadHit[] {
  const files: string[] = [];
  for (const dir of ['src', 'scripts']) walk(join(repoRoot, dir), files);
  const hits: EnvReadHit[] = [];
  for (const file of files) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((lineText, i) => {
      for (const m of lineText.matchAll(READ_PATTERN)) {
        // bracket-доступ с литералом: process.env['NAME']
        let name: string | null = m[1] ?? null;
        if (name === null) {
          const literal = /^\s*['"]([A-Z_][A-Z0-9_]*)['"]\]/.exec(lineText.slice((m.index ?? 0) + 'process.env'.length + 1));
          if (literal) name = literal[1] ?? null;
        }
        hits.push({ file: rel, line: i + 1, name });
      }
    });
  }
  return hits;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const strict = process.argv.includes('--strict');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const { envSchemaDocument } = await import('../src/config/env-schema.ts');
  const declared = new Set(envSchemaDocument().variables.map((v) => v.name));
  const hits = scanProcessEnvReads(repoRoot);

  const srcViolations = hits.filter(
    (h) => h.file.startsWith('src/') && !SRC_PROCESS_ENV_ALLOWLIST.has(h.file) && !LITERAL_ONLY_FILES.has(h.file),
  );
  const scriptUndeclared = hits.filter(
    (h) => h.file.startsWith('scripts/') && h.name !== null && !declared.has(h.name),
  );

  console.log(`[env:reads] чтений process.env всего: ${hits.length}`);
  if (srcViolations.length > 0) {
    console.log(`[env:reads] ОШИБКА — чтения в src/ вне allowlist (${srcViolations.length}):`);
    for (const h of srcViolations) console.log(`  ${h.file}:${h.line} ${h.name ?? '<dynamic>'}`);
  }
  if (scriptUndeclared.length > 0) {
    const names = [...new Set(scriptUndeclared.map((h) => h.name))].sort();
    console.log(`[env:reads] advisory — переменные scripts/ вне env-схемы (${names.length}): ${names.join(', ')}`);
    console.log('[env:reads] это CLI-инструменты; каталогизация — хвост roadmap env-catalog');
  }
  if (srcViolations.length > 0 || (strict && scriptUndeclared.length > 0)) process.exit(1);
  console.log('[env:reads] OK');
}
