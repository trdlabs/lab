export interface StrategyCodeFile {
  readonly name: string;
  readonly content: string;
}

/** Deterministic multi-file → single bot_code string. Reproduces the format that produced
 *  long-oi-profile.json's sourceFingerprint: files sorted by name, each prefixed with a
 *  `// ===== FILE: <pathPrefix>/<name> =====` header, joined by a blank line, no trailing newline. */
export function gatherStrategyCode(
  files: readonly StrategyCodeFile[],
  opts: { readonly pathPrefix: string },
): string {
  return [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `// ===== FILE: ${opts.pathPrefix}/${f.name} =====\n${f.content}`)
    .join('\n\n');
}
