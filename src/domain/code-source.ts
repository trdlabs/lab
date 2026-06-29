/** Файл исходника стратегии для анализа: относительный путь + содержимое. */
export interface CodeFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Конкатенация файлов в единый source-блок с явными FILE-границами для LLM-анализа.
 * Порядок файлов сохраняется (вызывающий решает порядок). Маркер: `// ===== FILE: <path> =====`.
 */
export function buildCodeSource(files: readonly CodeFile[]): string {
  return files.map((f) => `// ===== FILE: ${f.path} =====\n${f.content}`).join('\n\n');
}
