// Invariant guard: runtime code runs via `node --experimental-strip-types` (pnpm ingress / worker /
// platform:* / *:eval). Strip-only mode REJECTS TypeScript "parameter properties"
// (`constructor(private readonly x: T)`) with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at module load —
// tsc and Vitest (esbuild) both accept them, so this only surfaces at boot. This test fails the suite
// the moment a parameter property is introduced anywhere node strip-types will load, pointing at the
// exact site. Convert offenders to an explicit field declaration + assignment in the constructor body.
//
// Detection uses the TypeScript compiler AST (not regex) so a `readonly T[]` *type* on a normal
// parameter is NOT a false positive — only an accessibility/`readonly` MODIFIER on a ctor parameter is.

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/src
const REPO = dirname(HERE);
// The surfaces `node --experimental-strip-types` actually loads. Test files run under Vitest/esbuild
// (which accept parameter properties), so they are intentionally excluded.
const SCAN_DIRS = [join(REPO, 'src'), join(REPO, 'scripts')];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // dir may not exist (e.g. no scripts/) — nothing to scan
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function parameterPropertySites(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isConstructorDeclaration(node)) {
      for (const param of node.parameters) {
        const mods = ts.getModifiers(param) ?? [];
        const isParamProperty = mods.some(
          (m) =>
            m.kind === ts.SyntaxKind.PrivateKeyword ||
            m.kind === ts.SyntaxKind.PublicKeyword ||
            m.kind === ts.SyntaxKind.ProtectedKeyword ||
            m.kind === ts.SyntaxKind.ReadonlyKeyword,
        );
        if (isParamProperty) {
          lines.push(sf.getLineAndCharacterOfPosition(param.getStart(sf)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe('strip-types runtime invariant', () => {
  it('uses no TypeScript parameter properties in code node strip-types loads (src + scripts)', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8');
        const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
        for (const line of parameterPropertySites(sf)) {
          offenders.push(`${relative(REPO, file)}:${line}`);
        }
      }
    }
    expect(
      offenders,
      `TypeScript parameter properties break \`node --experimental-strip-types\` (pnpm ingress/worker) ` +
        `at module load. Replace each with an explicit field declaration + assignment in the ctor body:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});
