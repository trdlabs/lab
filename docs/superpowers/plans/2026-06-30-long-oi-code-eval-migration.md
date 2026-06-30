# long_oi External Code + Eval Migration (prose → code-golden) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the platform `long_oi` strategy code into trading-lab as a self-contained multi-file `bot_code` fixture, feed the analyst eval the CODE, introduce a code-derived golden (`CODE_LONG_OI_PROFILE`) for the golden-role consumers, rename the prose golden `GOOD_LONG_OI_PROFILE` → `CLEAN_LONG_OI_BASE` (its true role: a clean scorer-test base), and retire the prose source + prose-regen.

**Architecture:** A pure `gatherStrategyCode` reproduces the exact multi-file→string format that produced the committed code-golden's `sourceFingerprint`. The analyst scorer is **rubric-based** (structural/keyword checks, no reference comparison), so most `GOOD_LONG_OI_PROFILE` usages are scorer-input specimens — renamed, behavior-preserving. Only the **researcher fixture** and the **critic round-trip** are golden-role → switch to `CODE_LONG_OI_PROFILE` (re-baselined). Fully offline (no LLM).

**Tech Stack:** TypeScript under `node --experimental-strip-types`; Vitest; Zod; `node:fs`/`node:crypto`.

**Spec:** `docs/superpowers/specs/2026-06-30-long-oi-code-eval-migration-design.md`

> **Scope refinement (post-spec, user-approved "A"):** `GOOD_LONG_OI_PROFILE` is **renamed** to `CLEAN_LONG_OI_BASE` (its real role: a clean scorer-test base + crafted-variant base), NOT deleted as the spec §3.3 literally said. The analyst scorer is rubric-based (no reference comparison — confirmed), so only the **researcher fixture** and the **critic round-trip** are golden-role and switch to `CODE_LONG_OI_PROFILE`; all other usages are a behavior-preserving rename. This plan governs execution where it refines the spec.

## Global Constraints

- Runs under `node --experimental-strip-types`: **no TS parameter properties**; all relative imports keep `.ts`.
- `noUncheckedIndexedAccess` ON: guard indexed access; never `NaN`.
- **Both gates green per task:** `npm run typecheck` exit 0 AND `npx vitest run` green. `vitest run` does NOT typecheck — run `npm run typecheck` separately.
- **Fully offline** — no LLM call anywhere in this plan.
- Vendored code lives under `docs/fixtures/strategies/long-oi-code/` (NOT `src/` — `tsconfig.include` is `["src/**/*","test/**/*","*.config.ts"]`, so `docs/**` is never compiled). Vendored files are read as TEXT, never imported as modules.
- `gatherStrategyCode` MUST reproduce `long-oi-profile.json`'s `sourceFingerprint` = `sha256:2bdc5389969657cd46ec2500022350e768a0426d8d7bcbb01b14f344157f82b5` (verified: current platform code, this gather format → this hash).
- The analyst scorer is rubric-based (`completeness.ts`/`scoring.ts`/`fabrication.ts`), NOT reference-comparison — renaming the scorer-input specimen is behavior-preserving.
- `short-pump` fixtures are OUT OF SCOPE — leave them prose.

---

### Task 1: `gatherStrategyCode` (pure, deterministic)

**Files:**
- Create: `src/domain/strategy-code.ts`
- Test: `src/domain/strategy-code.test.ts`

**Interfaces:**
- Produces: `interface StrategyCodeFile { readonly name: string; readonly content: string }` and `function gatherStrategyCode(files: readonly StrategyCodeFile[], opts: { readonly pathPrefix: string }): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { gatherStrategyCode } from './strategy-code.ts';

describe('gatherStrategyCode', () => {
  it('sorts by name, prefixes a FILE header, joins with a blank line', () => {
    const out = gatherStrategyCode(
      [{ name: 'b.ts', content: 'B' }, { name: 'a.ts', content: 'A' }],
      { pathPrefix: 'src/strategies/long_oi' },
    );
    expect(out).toBe(
      '// ===== FILE: src/strategies/long_oi/a.ts =====\nA\n\n' +
      '// ===== FILE: src/strategies/long_oi/b.ts =====\nB',
    );
  });

  it('is deterministic and pure (no trailing newline)', () => {
    const files = [{ name: 'x.ts', content: 'x' }];
    expect(gatherStrategyCode(files, { pathPrefix: 'p' }))
      .toBe(gatherStrategyCode(files, { pathPrefix: 'p' }));
    expect(gatherStrategyCode(files, { pathPrefix: 'p' }).endsWith('\n')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/domain/strategy-code.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/domain/strategy-code.ts`:
```ts
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/domain/strategy-code.test.ts` → PASS.
Run: `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/strategy-code.ts src/domain/strategy-code.test.ts
git commit -m "feat(domain): gatherStrategyCode — deterministic multi-file bot_code join"
```

> **Note on `.localeCompare` vs the golden:** the regen script used `readdirSync(...).sort()` (default lexicographic). For the 7 long_oi ASCII filenames (`flat_phase, manifest, module, params, position_phase, signals, state`) `.localeCompare` and default `.sort()` give the same order. Task 2's fingerprint guard is the authority — if it fails, switch the sort to `(a,b)=>a.name<b.name?-1:a.name>b.name?1:0` and re-run.

---

### Task 2: Vendor long_oi code + fingerprint guard

**Files:**
- Create: `docs/fixtures/strategies/long-oi-code/*.ts` (7 files, byte-copied) + `docs/fixtures/strategies/long-oi-code/README.md`
- Test: `docs/fixtures/strategies/long-oi-code.fingerprint.test.ts` → place under `src/experiments/strategy-analyst/__fixtures__/long-oi-code-fingerprint.test.ts` (must be under `src/` so vitest runs it)

**Interfaces:**
- Consumes: `gatherStrategyCode` (Task 1); `sourceFingerprint(kind, content)` from `src/domain/fingerprint.ts`.
- Produces: the vendored code dir read at `docs/fixtures/strategies/long-oi-code/`.

- [ ] **Step 1: Vendor the files**

```bash
mkdir -p docs/fixtures/strategies/long-oi-code
cp ../trading-platform/src/strategies/long_oi/*.ts docs/fixtures/strategies/long-oi-code/
ls docs/fixtures/strategies/long-oi-code/   # expect: flat_phase.ts manifest.ts module.ts params.ts position_phase.ts signals.ts state.ts
```

Create `docs/fixtures/strategies/long-oi-code/README.md`:
```markdown
# long_oi strategy code (vendored fixture)

Byte-identical copy of `trading-platform/src/strategies/long_oi/*.ts`, vendored into trading-lab so
the analyst eval + `scripts/regen-from-code.mts` are self-contained (no sibling repo needed). Treated
as third-party strategy code, NOT compiled (lives under `docs/`, outside `tsconfig.include`).

To re-vendor (only if the upstream long_oi changes): copy the files again and run
`src/experiments/strategy-analyst/__fixtures__/long-oi-code-fingerprint.test.ts`. If the fingerprint
guard fails, the code changed → regenerate the golden with `scripts/regen-from-code.mts` (one LLM call).
```

- [ ] **Step 2: Write the failing fingerprint guard**

`src/experiments/strategy-analyst/__fixtures__/long-oi-code-fingerprint.test.ts`:
```ts
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
```

- [ ] **Step 3: Run it — expect PASS immediately** (the vendor + gather + golden already align; verified offline)

Run: `npx vitest run src/experiments/strategy-analyst/__fixtures__/long-oi-code-fingerprint.test.ts`
Expected: PASS. **If FAIL:** the `.sort()` differs (see Task 1 note) OR the vendored bytes differ from upstream — re-copy and adjust the sort; do NOT regenerate the golden (the code matched at planning time).

- [ ] **Step 4: typecheck**

Run: `npm run typecheck` → exit 0. (The vendored `.ts` under `docs/` are NOT compiled — confirm no new tsc errors.)

- [ ] **Step 5: Commit**

```bash
git add docs/fixtures/strategies/long-oi-code/ src/experiments/strategy-analyst/__fixtures__/long-oi-code-fingerprint.test.ts
git commit -m "test(eval): vendor long_oi code fixture + fingerprint guard vs code-golden"
```

---

### Task 3: `CODE_LONG_OI_PROFILE` loader

**Files:**
- Create: `src/experiments/strategy-analyst/__fixtures__/code-golden.ts`
- Test: `src/experiments/strategy-analyst/__fixtures__/code-golden.test.ts`

**Interfaces:**
- Consumes: `AnalystProfileOutputSchema`, `AnalystProfileOutput` from `src/domain/strategy-profile.ts`; the JSON at `src/adapters/builder/fixtures/long-oi-profile.json`.
- Produces: `export const CODE_LONG_OI_PROFILE: AnalystProfileOutput`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { CODE_LONG_OI_PROFILE } from './code-golden.ts';

describe('CODE_LONG_OI_PROFILE', () => {
  it('loads the code-derived golden (direction long, high confidence, bot_code provenance)', () => {
    expect(CODE_LONG_OI_PROFILE.direction).toBe('long');
    expect(CODE_LONG_OI_PROFILE.confidence).toBeGreaterThanOrEqual(0.9);
    expect(CODE_LONG_OI_PROFILE.requiredMarketFeatures.length).toBeGreaterThan(0);
    expect(CODE_LONG_OI_PROFILE.coreIdea).toMatch(/dump|reversal|bounce/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/experiments/strategy-analyst/__fixtures__/code-golden.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/experiments/strategy-analyst/__fixtures__/code-golden.ts`:
```ts
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/experiments/strategy-analyst/__fixtures__/code-golden.test.ts` → PASS.
Run: `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/experiments/strategy-analyst/__fixtures__/code-golden.ts src/experiments/strategy-analyst/__fixtures__/code-golden.test.ts
git commit -m "feat(eval): CODE_LONG_OI_PROFILE — code-derived golden loader (validated)"
```

---

### Task 4: Rename `GOOD_LONG_OI_PROFILE` → `CLEAN_LONG_OI_BASE` (behavior-preserving)

**Files (rename the export + every scorer-base importer):**
- Modify: `src/experiments/strategy-analyst/__fixtures__/profiles.ts` (the `export const` at line 5 + the variant spreads at lines 43/47/53/59/65-66/72)
- Modify: `src/experiments/strategy-analyst/{scoring.test.ts, completeness.test.ts, fabrication.test.ts, eval-harness.test.ts, judge.test.ts}`
- Modify: `src/experiments/strategy-critic/{judge.test.ts, types.test.ts}`

**Interfaces:**
- Produces: `export const CLEAN_LONG_OI_BASE: AnalystProfileOutput` (renamed from `GOOD_LONG_OI_PROFILE`; identical value). The variant fixtures (`SHORT_DIRECTION_PROFILE`, `FABRICATED_RISK_PROFILE`, `DCA_HINT_RISK_PROFILE`, `MISSING_TP2_PROFILE`, `POSMGMT_IN_SUMMARY_PROFILE`, `RU_PROFILE`) now spread from `CLEAN_LONG_OI_BASE`.

This is a pure rename — **no behavior change**. The doc-comment on the export should change from "A strong long_oi profile that should PASS every check" to "A clean, structurally-simple long_oi-shaped profile used as the base for analyst/critic scorer-test specimens and crafted negative variants. NOT the golden — see CODE_LONG_OI_PROFILE."

> **Do NOT touch** `src/experiments/researcher/fixtures.ts` (Task 5) or `src/experiments/strategy-critic/eval-harness.test.ts` (Task 6) — those are golden-role and switch to `CODE_LONG_OI_PROFILE`, not the rename.

- [ ] **Step 1: Rename the export + spreads in `profiles.ts`**

In `src/experiments/strategy-analyst/__fixtures__/profiles.ts`: rename `export const GOOD_LONG_OI_PROFILE` → `export const CLEAN_LONG_OI_BASE`; replace every `...GOOD_LONG_OI_PROFILE` / `GOOD_LONG_OI_PROFILE.` in the variant definitions with `...CLEAN_LONG_OI_BASE` / `CLEAN_LONG_OI_BASE.`; update the doc comment.

- [ ] **Step 2: Update the scorer-base importers**

In each of `scoring.test.ts, completeness.test.ts, fabrication.test.ts, eval-harness.test.ts, judge.test.ts` (analyst) and `judge.test.ts, types.test.ts` (critic): change the import `{ GOOD_LONG_OI_PROFILE }` → `{ CLEAN_LONG_OI_BASE }` and replace every `GOOD_LONG_OI_PROFILE` identifier with `CLEAN_LONG_OI_BASE`. Find them all:

```bash
grep -rln "GOOD_LONG_OI_PROFILE" src/experiments/strategy-analyst src/experiments/strategy-critic
```
(Exclude `researcher/fixtures.ts` and `strategy-critic/eval-harness.test.ts` — Tasks 5/6.)

- [ ] **Step 3: Run the affected suites + typecheck — must stay GREEN (rename only)**

Run: `npx vitest run src/experiments/strategy-analyst src/experiments/strategy-critic`
Expected: GREEN, same pass count as before (pure rename, no assertion changes). If any test references `GOOD_LONG_OI_PROFILE` still, the grep missed it — fix.
Run: `npm run typecheck` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/experiments/strategy-analyst src/experiments/strategy-critic
git commit -m "refactor(eval): rename GOOD_LONG_OI_PROFILE -> CLEAN_LONG_OI_BASE (scorer-test base, not golden)"
```

---

### Task 5: Researcher fixture → `CODE_LONG_OI_PROFILE` (golden-role)

**Files:**
- Modify: `src/experiments/researcher/fixtures.ts` (`longOiStrategyProfile()`, ~lines 4, 25-50)
- Test: re-baseline whatever researcher-eval tests assert on `longOiStrategyProfile()` (find them)

**Interfaces:**
- Consumes: `CODE_LONG_OI_PROFILE` (Task 3).
- Produces: `longOiStrategyProfile()` returns a `StrategyProfile` whose `.profile` is `CODE_LONG_OI_PROFILE`, `sourceKind: 'bot_code'`, `uri` pointing at the vendored code dir.

- [ ] **Step 1: Update the fixture**

Replace the import `import { GOOD_LONG_OI_PROFILE } from '../strategy-analyst/__fixtures__/profiles.ts';` with `import { CODE_LONG_OI_PROFILE } from '../strategy-analyst/__fixtures__/code-golden.ts';` and rewrite `longOiStrategyProfile()`:
```ts
export function longOiStrategyProfile(): StrategyProfile {
  return {
    id: 'long-oi-profile',
    version: 1,
    sourceKind: 'bot_code',
    sourceFingerprint: 'sha256:2bdc5389969657cd46ec2500022350e768a0426d8d7bcbb01b14f344157f82b5',
    direction: CODE_LONG_OI_PROFILE.direction,
    coreIdea: CODE_LONG_OI_PROFILE.coreIdea,
    requiredMarketFeatures: CODE_LONG_OI_PROFILE.requiredMarketFeatures,
    confidence: CODE_LONG_OI_PROFILE.confidence,
    unknowns: CODE_LONG_OI_PROFILE.unknowns,
    profile: CODE_LONG_OI_PROFILE,
    sourceArtifactRef: {
      artifact_id: 'fixture-long-oi-code',
      uri: 'docs/fixtures/strategies/long-oi-code',
      content_hash: 'sha256:2bdc5389969657cd46ec2500022350e768a0426d8d7bcbb01b14f344157f82b5',
      kind: 'strategy_source',
      size_bytes: 70863,
      mime_type: 'text/plain',
      created_at: '2026-06-29T21:01:46.487Z',
      producer: 'scripts/regen-from-code.mts',
      metadata: { sourceKind: 'bot_code', uri: null, title: null },
    },
    contractVersion: 'strategy-profile-v1',
    createdAt: '2026-06-29T21:01:46.487Z',
    updatedAt: '2026-06-29T21:01:46.487Z',
  };
}
```

- [ ] **Step 2: Find + run the researcher-eval tests that touch it, re-baseline**

```bash
grep -rln "longOiStrategyProfile" src/experiments/researcher scripts
npx vitest run src/experiments/researcher
```
Expected: tests asserting the old prose values (coreIdea/requiredMarketFeatures/confidence 0.8) now FAIL → update each assertion to the code-golden value (direction stays `long`; confidence is 0.99; coreIdea/features are the richer code-derived strings — read them from `CODE_LONG_OI_PROFILE`). Update to the ACTUAL values the test now sees; do not invent.

- [ ] **Step 3: typecheck + suite**

Run: `npm run typecheck` → exit 0.
Run: `npx vitest run src/experiments/researcher` → GREEN.

- [ ] **Step 4: Commit**

```bash
git add src/experiments/researcher
git commit -m "feat(eval): researcher long_oi fixture -> CODE_LONG_OI_PROFILE (bot_code golden)"
```

---

### Task 6: Critic round-trip → `CODE_LONG_OI_PROFILE` (golden-role)

**Files:**
- Modify: `src/experiments/strategy-critic/eval-harness.test.ts` (the golden-role uses — `fakeAnalyst(...)` round-trip + the `judgeProfile` init, ~lines 12, 130, 138, 162)

**Interfaces:**
- Consumes: `CODE_LONG_OI_PROFILE` (Task 3).

- [ ] **Step 1: Switch the import + the golden-role usages**

In `src/experiments/strategy-critic/eval-harness.test.ts`: import `CODE_LONG_OI_PROFILE` from `../strategy-analyst/__fixtures__/code-golden.ts`; replace the `GOOD_LONG_OI_PROFILE` references that represent the analyst's ideal output (the `fakeAnalyst(GOOD_LONG_OI_PROFILE...)` round-trip calls + the `judgeProfile` init) with `CODE_LONG_OI_PROFILE`.

- [ ] **Step 2: Run + re-baseline**

Run: `npx vitest run src/experiments/strategy-critic/eval-harness.test.ts`
Expected: assertions that hardcoded prose-golden values may FAIL → re-baseline to the code-golden's values (the critic now critiques the richer profile; `scoreCompleteness` should still pass it, but specific score/field assertions update to what the test now produces).

- [ ] **Step 3: typecheck + suite**

Run: `npm run typecheck` → exit 0.
Run: `npx vitest run src/experiments/strategy-critic` → GREEN.

- [ ] **Step 4: Commit**

```bash
git add src/experiments/strategy-critic/eval-harness.test.ts
git commit -m "feat(eval): critic round-trip uses CODE_LONG_OI_PROFILE (golden analyst output)"
```

---

### Task 7: Analyst eval input = vendored CODE (FixtureRef `sourceDir`)

**Files:**
- Modify: `src/experiments/strategy-analyst/types.ts` (`FixtureRef`)
- Modify: `src/experiments/strategy-analyst/fixtures.ts` (`FIXTURES['long-oi']`)
- Modify: `scripts/strategy-analyst-eval.ts` (the source read site, ~lines 60-61)
- Test: `src/experiments/strategy-analyst/fixtures.test.ts` (extend)

**Interfaces:**
- Consumes: `gatherStrategyCode` (Task 1).
- Produces: `FixtureRef` gains an optional `sourceDir?: string` + `kind?: 'manual_description' | 'bot_code'`; `sourcePath` becomes optional. `FIXTURES['long-oi']` uses `sourceDir` + `kind: 'bot_code'`; `short-pump` keeps `sourcePath`.

- [ ] **Step 1: Write the failing test (fixtures.test.ts)**

Add:
```ts
import { resolveFixture } from './fixtures.ts';
it('long-oi resolves to the vendored CODE dir as bot_code; short-pump stays prose', () => {
  const longOi = resolveFixture('long-oi');
  expect(longOi.sourceDir).toBe('docs/fixtures/strategies/long-oi-code');
  expect(longOi.kind).toBe('bot_code');
  const shortPump = resolveFixture('short-pump');
  expect(shortPump.sourcePath).toMatch(/short-pump-strategy-source\.md$/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/experiments/strategy-analyst/fixtures.test.ts -t "vendored CODE dir"`
Expected: FAIL — `sourceDir`/`kind` not present.

- [ ] **Step 3: Extend `FixtureRef` + `FIXTURES`**

In `types.ts`, change `FixtureRef`:
```ts
export interface FixtureRef {
  readonly sourcePath?: string;   // prose source (manual_description/readme/article)
  readonly sourceDir?: string;    // multi-file code dir (bot_code) — gathered at read time
  readonly kind?: 'manual_description' | 'bot_code';
  readonly notesPath: string;
  readonly rubricPath: string;
  readonly direction: 'long' | 'short';
}
```
In `fixtures.ts`, `FIXTURES['long-oi']`:
```ts
'long-oi': {
  id: 'long-oi',
  sourceDir: `${DIR}/long-oi-code`,
  kind: 'bot_code',
  notesPath: `${DIR}/long-oi-strategy-research-notes.md`,
  rubricPath: `${DIR}/long-oi-strategy-rubric.md`,
  direction: 'long',
},
```
(`short-pump` keeps `sourcePath` + add `kind: 'manual_description'`.)

- [ ] **Step 4: Update the read site (`scripts/strategy-analyst-eval.ts`)**

Replace the single-file read (`const fixtureText = readFileSync(fixture.sourcePath, 'utf8');`) with a branch that gathers a code dir or reads prose:
```ts
import { readdirSync } from 'node:fs';
import { gatherStrategyCode } from '../src/domain/strategy-code.ts';
// ...
let fixtureText: string;
let inputKind: 'manual_description' | 'bot_code';
if (fixture.sourceDir) {
  const files = readdirSync(fixture.sourceDir)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, content: readFileSync(join(fixture.sourceDir!, name), 'utf8') }));
  fixtureText = gatherStrategyCode(files, { pathPrefix: 'src/strategies/long_oi' });
  inputKind = fixture.kind ?? 'bot_code';
} else {
  fixtureText = readFileSync(fixture.sourcePath!, 'utf8');
  inputKind = fixture.kind ?? 'manual_description';
}
```
Use `inputKind` where the script builds the analyst input `{ kind, content: fixtureText }` (replace the hardcoded kind). Ensure `join` is imported from `node:path`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/experiments/strategy-analyst/fixtures.test.ts` → PASS.
Run: `npm run typecheck` → exit 0 (the optional-field change must not break other `FixtureRef` consumers — fix any `sourcePath` access that's now possibly-undefined with a guard).

- [ ] **Step 6: Commit**

```bash
git add src/experiments/strategy-analyst/types.ts src/experiments/strategy-analyst/fixtures.ts scripts/strategy-analyst-eval.ts src/experiments/strategy-analyst/fixtures.test.ts
git commit -m "feat(eval): analyst long-oi fixture analyzes vendored CODE (FixtureRef sourceDir)"
```

---

### Task 8: `regen-from-code.mts` reads the vendor + uses `gatherStrategyCode`

**Files:**
- Modify: `scripts/regen-from-code.mts`

**Interfaces:**
- Consumes: `gatherStrategyCode` (Task 1).

- [ ] **Step 1: Repoint the default source dir + use the shared gather**

In `scripts/regen-from-code.mts`:
- Change the default `MODULE_DIR`: from the platform path to the vendored dir. Replace the `platformRepo`/`MODULE_DIR` block with:
  ```ts
  // Self-contained: read the vendored long_oi code. Override with LONGOI_CODE_DIR for a fresh re-vendor source.
  const MODULE_DIR = process.env['LONGOI_CODE_DIR']
    ?? resolve(__dirname, '../docs/fixtures/strategies/long-oi-code');
  ```
  (Drop the now-unused `platformRepo` line.)
- Replace the private `gatherCode` function with the shared one:
  ```ts
  import { gatherStrategyCode } from '../src/domain/strategy-code.ts';
  // ...
  const files = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, content: readFileSync(join(MODULE_DIR, name), 'utf8') }));
  const content = gatherStrategyCode(files, { pathPrefix: 'src/strategies/long_oi' });
  ```
  (Remove the old `function gatherCode(dir)`.)

- [ ] **Step 2: Verify offline (no LLM) — fingerprint reproduction**

The script makes a real LLM call (not run here). Instead, verify the gather alone reproduces the golden fingerprint via a one-off node check:
```bash
node --experimental-strip-types -e "
import('./src/domain/strategy-code.ts').then(async ({gatherStrategyCode}) => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { sourceFingerprint } = await import('./src/domain/fingerprint.ts');
  const dir = 'docs/fixtures/strategies/long-oi-code';
  const files = readdirSync(dir).filter(f=>f.endsWith('.ts')).map(name=>({name, content: readFileSync(join(dir,name),'utf8')}));
  const fp = sourceFingerprint('bot_code', gatherStrategyCode(files,{pathPrefix:'src/strategies/long_oi'}));
  console.log(fp === 'sha256:2bdc5389969657cd46ec2500022350e768a0426d8d7bcbb01b14f344157f82b5' ? 'OK' : 'MISMATCH '+fp);
});
"
```
Expected: `OK`. (This is the same invariant Task 2 guards; here it confirms the regen path's dir + gather agree.)

- [ ] **Step 3: typecheck**

Run: `npm run typecheck` → exit 0. (`scripts/` is NOT in `tsconfig.include`, but keep imports valid; if a `scripts/*.mts` typecheck gate exists, satisfy it.)

- [ ] **Step 4: Commit**

```bash
git add scripts/regen-from-code.mts
git commit -m "refactor(scripts): regen-from-code reads vendored long_oi + shared gatherStrategyCode"
```

---

### Task 9: Retire prose + full-suite sweep

**Files:**
- Delete: `docs/fixtures/strategies/long-oi-strategy-source.md`
- Delete: `scripts/regen-long-oi-profile.mts`
- Modify: `docs/fixtures/strategies/long-oi-strategy-research-notes.md` + `long-oi-strategy-rubric.md` (remove/repoint any line referencing the deleted prose source)
- Modify: any remaining reference to the deleted files

- [ ] **Step 1: Find every reference to the prose source + prose-regen**

```bash
grep -rln "long-oi-strategy-source\|regen-long-oi-profile" src scripts docs
```
Expected remaining refs after Tasks 5/7: the research-notes/rubric prose mentions + maybe spec/plan docs (leave historical specs/plans alone). Repoint the notes/rubric lines that point at the source `.md` to the vendored code dir, or drop the pointer if it's just provenance.

- [ ] **Step 2: Delete the files**

```bash
git rm docs/fixtures/strategies/long-oi-strategy-source.md scripts/regen-long-oi-profile.mts
```

- [ ] **Step 3: Confirm `GOOD_LONG_OI_PROFILE` is fully gone**

```bash
grep -rn "GOOD_LONG_OI_PROFILE" src scripts   # expect: no matches
```
If any remain, they were missed in Tasks 4/5/6 — resolve (rename or switch per role).

- [ ] **Step 4: FULL gates**

Run: `npm run typecheck` → exit 0.
Run: `npx vitest run` → all green (0 failed). Investigate any failure (a missed prose reference, a `sourcePath`-now-optional access, a stale assertion).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(eval): retire prose long_oi source + prose-regen script"
```

---

## Notes for the implementer

- **The rename (Task 4) is behavior-preserving** — no assertion should change there. If a Task-4 test fails on a value, you renamed something you shouldn't have (a golden-role usage) — re-check against the role map: only `researcher/fixtures.ts` (Task 5) and `strategy-critic/eval-harness.test.ts` (Task 6) are golden-role.
- **Re-baselining (Tasks 5/6)**: the new expected values come from `CODE_LONG_OI_PROFILE` (read the actual loaded object / the test's actual output) — never invent a value. The code-golden is deterministic.
- **`FixtureRef.sourcePath` is now optional** — every existing access of `fixture.sourcePath` outside the eval script must be guarded or is provably prose-only; `npm run typecheck` is your finder.
- **Do not regenerate `long-oi-profile.json`** — it is consumed, not produced, by this slice. The fingerprint guard (Task 2) proves the vendored code still matches it.
- **`short-pump` stays prose** — do not migrate it.
- **`scripts/` is NOT covered by `npm run typecheck`** (`tsconfig.include` = `src`/`test` only — see [[trading-lab-tsc-does-not-cover-scripts-dir]]). So the Task 7/8 edits to `scripts/strategy-analyst-eval.ts` and `scripts/regen-from-code.mts` are NOT gate-verified by typecheck. Task 8 step 2 exercises the shared gather offline; for the Task 7 read-site branch, manually sanity-check that imports/paths resolve (e.g. a node one-off that runs only the `sourceDir` read+gather block) — do not rely on typecheck to catch a broken script edit.
