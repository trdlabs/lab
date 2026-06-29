import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CodeFile } from '../../domain/code-source.ts';

/**
 * Рекурсивно читает исходные файлы из `dir` (по умолчанию `.ts`), исключая `*.test.ts`.
 * Возвращает CodeFile[] с path относительно `dir` (POSIX-разделители), в детерминированном
 * лексикографическом порядке. Источник = поведенческие файлы стратегии (вызывающий выбирает dir).
 */
export function readCodeDir(dir: string, exts: readonly string[] = ['.ts']): CodeFile[] {
  const out: CodeFile[] = [];
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur).sort()) {
      const full = join(cur, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (name.endsWith('.test.ts')) continue;
      if (!exts.some((e) => name.endsWith(e))) continue;
      out.push({ path: relative(dir, full).split(sep).join('/'), content: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
