# LLM Builder Proof Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить временный proof-харнесс `src/proof/`, который итеративно авторит бандл LLM-билдером (F2a) и доказывает его платформенный paper-паритет с curated long_oi, итерируя по структурному feedback'у до сходимости.

**Architecture:** `runBuilderProofLoop` крутит `build → assemble → L2 validate → L3 platform prove (prove_bundle.mjs через BundleProverPort) → feedback → loop` до `proven` ∨ `maxIterations`. Платформа потребляется через shell-адаптер CLI (прямой lab→platform, без подписи). Mock-механизм доказывается герметично; реальный LLM — отдельный gated eval.

**Tech Stack:** TypeScript ESM (`.ts`, node22), vitest, esbuild (через `assembleStrategyBundle`), Mastra (F2a `MastraStrategyBuilder`).

## Global Constraints

- Все `.ts` ESM, импорты с расширением `.ts` (проектная конвенция).
- НЕ трогать `src/orchestrator/handlers/author-strategy-bundle.handler.ts` (F1 backtester-путь отдельный).
- НЕ подпись/admission/HTTP. Платформа — только через CLI `prove_bundle.mjs`.
- `pnpm check` (vitest) ДОЛЖЕН оставаться зелёным; gated real-LLM eval — ВНЕ vitest.
- Проза в коммитах/комментах — допускается русский (проектная норма).
- `Verdict.divergence` форма ДОЛЖНА быть `{ bar:number; field:string; expected:unknown; actual:unknown }` — идентична `BuildFeedback['parity']['diff']` (выравнивание с F2a-портом).

---

### Task 1: Carry-over №1 — evidence/confidence в user-message билдера

Заземление: F2a отложил сериализацию `profile.evidence`/`confidence` в промпт (см. F2a `.superpowers/sdd/deferred-minors.md`, №1). Это grounding для сходимости реального LLM — чиним первым.

**Files:**
- Modify: `src/adapters/builder/strategy-user-message.ts`
- Test: `src/adapters/builder/strategy-user-message.test.ts`

**Interfaces:**
- Consumes: `buildStrategyUserMessage(profile: AnalystProfileOutput, feedback?: BuildFeedback): string` (существует).
- Produces: тот же сигнатур; в выводе теперь присутствуют `evidence`-строки и `confidence`.

- [ ] **Step 1: Написать падающий тест**

В `src/adapters/builder/strategy-user-message.test.ts` добавить (PROFILE уже имеет `evidence: ['OI spike precedes price move (backtested 3 months)']`, `confidence: 0.8`):

```ts
it('includes evidence lines in output', () => {
  const msg = buildStrategyUserMessage(PROFILE);
  for (const ev of PROFILE.evidence) {
    expect(msg).toContain(ev);
  }
});

it('includes confidence in output', () => {
  const msg = buildStrategyUserMessage(PROFILE);
  expect(msg).toContain(String(PROFILE.confidence));
});
```

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `cd <worktree> && npx vitest run src/adapters/builder/strategy-user-message.test.ts`
Expected: FAIL — `evidence`/`confidence` ещё не сериализуются.

- [ ] **Step 3: Минимальная реализация**

В `src/adapters/builder/strategy-user-message.ts` найти секцию сборки профиля и добавить блоки evidence/confidence рядом с прочими полями (стиль — как соседние секции; например после `riskManagementSummary`):

```ts
    `## Confidence\n${profile.confidence}`,
    `## Evidence\n${profile.evidence.map((e) => `- ${e}`).join('\n')}`,
```

(Точное место — где собирается массив секций промпта; вставить так, чтобы попало в итоговую строку.)

- [ ] **Step 4: Прогнать — убедиться, что зелено**

Run: `npx vitest run src/adapters/builder/strategy-user-message.test.ts`
Expected: PASS (все тесты файла).

- [ ] **Step 5: Коммит**

```bash
git add src/adapters/builder/strategy-user-message.ts src/adapters/builder/strategy-user-message.test.ts
git commit -m "fix(builder): сериализовать profile.evidence/confidence в user-message (carry-over №1)"
```

---

### Task 2: BundleProverPort + петля (happy-path proven)

**Files:**
- Create: `src/proof/bundle-prover.port.ts`
- Create: `src/proof/builder-proof-loop.ts`
- Test: `src/proof/builder-proof-loop.test.ts`

**Interfaces:**
- Consumes: `StrategyBuilder`, `StrategyBuilderInput`, `BuildFeedback` (`src/ports/strategy-builder.port.ts`); `assembleStrategyBundle(o: StrategyBuilderOutput): Promise<AssembledStrategyBundle>` (`src/domain/strategy-bundle.ts`); `validateStrategyBundle(a: AssembledStrategyBundle): ValidationVerdict` (`src/validation/strategy-bundle-validator.ts`); `FakeStrategyBuilder` (`src/adapters/builder/fake-strategy-builder.ts`).
- Produces:
  - `ProofVerdict` union; `BundleProverPort { prove(bundleSource: string): Promise<ProofVerdict> }`.
  - `runBuilderProofLoop(deps): Promise<ProofOutcome>` где `ProofOutcome { proven: boolean; attempts: number; lastVerdict?: ProofVerdict; lastViolations?: string[] }`.

- [ ] **Step 1: Создать порт**

`src/proof/bundle-prover.port.ts`:

```ts
// F2b — порт платформенного proof-seam (trading-platform 050 prove_bundle.mjs).
// Verdict.divergence форма идентична BuildFeedback['parity']['diff'] — выравнивание с F2a-портом.
export type ProofVerdict =
  | { readonly proven: true }
  | { readonly proven: false; readonly divergence: { bar: number; field: string; expected: unknown; actual: unknown } }
  | { readonly proven: false; readonly failClosed: { reason: string } };

export interface BundleProverPort {
  prove(bundleSource: string): Promise<ProofVerdict>;
}
```

- [ ] **Step 2: Написать падающий тест (proven за 1 попытку)**

`src/proof/builder-proof-loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeStrategyBuilder } from '../adapters/builder/fake-strategy-builder.ts';
import { runBuilderProofLoop } from './builder-proof-loop.ts';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';
import type { StrategyBuilderInput } from '../ports/strategy-builder.port.ts';

const INPUT = {
  spec: { goal: 'long oi rebound' },
  authoringDoc: 'doc',
  profile: undefined,
} as unknown as StrategyBuilderInput;

class ScriptedProver implements BundleProverPort {
  private i = 0;
  constructor(private readonly verdicts: ProofVerdict[]) {}
  async prove(): Promise<ProofVerdict> { return this.verdicts[this.i++]; }
}

describe('runBuilderProofLoop', () => {
  it('proven на первой попытке → attempts=1', async () => {
    const outcome = await runBuilderProofLoop({
      builder: new FakeStrategyBuilder(),
      prover: new ScriptedProver([{ proven: true }]),
      input: INPUT,
    });
    expect(outcome.proven).toBe(true);
    expect(outcome.attempts).toBe(1);
  });
});
```

- [ ] **Step 3: Прогнать — FAIL**

Run: `npx vitest run src/proof/builder-proof-loop.test.ts`
Expected: FAIL — `runBuilderProofLoop` не определён.

- [ ] **Step 4: Реализация петли**

`src/proof/builder-proof-loop.ts`:

```ts
import type { StrategyBuilder, StrategyBuilderInput, BuildFeedback } from '../ports/strategy-builder.port.ts';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';
import { assembleStrategyBundle } from '../domain/strategy-bundle.ts';
import { validateStrategyBundle } from '../validation/strategy-bundle-validator.ts';

export interface ProofOutcome {
  readonly proven: boolean;
  readonly attempts: number;
  readonly lastVerdict?: ProofVerdict;
  readonly lastViolations?: string[];
}

export interface BuilderProofLoopDeps {
  readonly builder: StrategyBuilder;
  readonly prover: BundleProverPort;
  readonly input: StrategyBuilderInput;
  readonly maxIterations?: number;
}

function verdictToFeedback(v: Extract<ProofVerdict, { proven: false }>): BuildFeedback {
  if ('divergence' in v) return { kind: 'parity', diff: v.divergence };
  return { kind: 'validation', violations: [v.failClosed.reason] };
}

export async function runBuilderProofLoop(deps: BuilderProofLoopDeps): Promise<ProofOutcome> {
  const maxIterations = deps.maxIterations ?? 5;
  let feedback: BuildFeedback | undefined;
  let lastVerdict: ProofVerdict | undefined;
  let lastViolations: string[] | undefined;

  for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
    const out = await deps.builder.build({ ...deps.input, feedback });
    const bundle = await assembleStrategyBundle(out);

    const verdict = validateStrategyBundle(bundle);
    if (verdict.status === 'rejected') {
      lastViolations = verdict.violations;
      feedback = { kind: 'validation', violations: verdict.violations };
      continue;
    }

    const proof = await deps.prover.prove(bundle.source);
    if (proof.proven) return { proven: true, attempts: attempt };
    lastVerdict = proof;
    feedback = verdictToFeedback(proof);
  }

  return { proven: false, attempts: maxIterations, lastVerdict, lastViolations };
}
```

- [ ] **Step 5: Прогнать — PASS**

Run: `npx vitest run src/proof/builder-proof-loop.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/proof/bundle-prover.port.ts src/proof/builder-proof-loop.ts src/proof/builder-proof-loop.test.ts
git commit -m "feat(proof): BundleProverPort + runBuilderProofLoop (proven happy-path)"
```

---

### Task 3: Сходимость divergence→feedback→proven

**Files:**
- Modify: `src/proof/builder-proof-loop.test.ts`

**Interfaces:**
- Consumes: `runBuilderProofLoop`, `ProofVerdict` (Task 2).
- Produces: — (только тест; покрывает feedback-threading).

- [ ] **Step 1: Тест сходимости + threading**

Добавить в `src/proof/builder-proof-loop.test.ts` recording-builder и сценарий:

```ts
import type { StrategyBuilderOutput } from '../ports/strategy-builder.port.ts';

class RecordingBuilder implements import('../ports/strategy-builder.port.ts').StrategyBuilder {
  readonly adapter = 'rec';
  readonly model = 'rec';
  readonly feedbacks: (import('../ports/strategy-builder.port.ts').BuildFeedback | undefined)[] = [];
  private readonly inner = new FakeStrategyBuilder();
  async build(i: StrategyBuilderInput): Promise<StrategyBuilderOutput> {
    this.feedbacks.push(i.feedback);
    return this.inner.build(i);
  }
}

it('divergence → parity-feedback → proven на 2-й попытке', async () => {
  const builder = new RecordingBuilder();
  const outcome = await runBuilderProofLoop({
    builder,
    prover: new ScriptedProver([
      { proven: false, divergence: { bar: 14, field: 'qty', expected: 1, actual: 1.5 } },
      { proven: true },
    ]),
    input: INPUT,
  });
  expect(outcome.proven).toBe(true);
  expect(outcome.attempts).toBe(2);
  // 1-я попытка — без feedback; 2-я — parity-feedback от divergence
  expect(builder.feedbacks[0]).toBeUndefined();
  expect(builder.feedbacks[1]).toEqual({ kind: 'parity', diff: { bar: 14, field: 'qty', expected: 1, actual: 1.5 } });
});
```

- [ ] **Step 2: Прогнать — PASS (реализация уже есть из Task 2)**

Run: `npx vitest run src/proof/builder-proof-loop.test.ts`
Expected: PASS — петля прокидывает parity-feedback на 2-й build.

- [ ] **Step 3: Коммит**

```bash
git add src/proof/builder-proof-loop.test.ts
git commit -m "test(proof): сходимость divergence→feedback→proven + threading"
```

---

### Task 4: Ветка L2 (validation), failClosed→validation, maxIters-исчерпание

**Files:**
- Create: `src/proof/builder-proof-loop.fixtures.ts`
- Modify: `src/proof/builder-proof-loop.test.ts`

**Interfaces:**
- Consumes: `runBuilderProofLoop`, `FakeStrategyBuilder`, `StrategyBuilder`/`StrategyBuilderOutput`.
- Produces: `AmbientBuilder` (test fixture, всегда возвращает бандл с ambient-нарушением).

- [ ] **Step 1: Fixture — билдер с ambient-нарушением (L2 reject)**

`src/proof/builder-proof-loop.fixtures.ts`:

```ts
import type { StrategyBuilder, StrategyBuilderInput, StrategyBuilderOutput, StrategyManifestMeta } from '../ports/strategy-builder.port.ts';

// Источник с ambient-доступом → validateStrategyBundle вернёт status:'rejected'.
const AMBIENT_SOURCE =
  'export default function createStrategyModule(){ const s = process.env.SECRET; return { init(){}, onBarClose(){ return s; } }; }';

const AMBIENT_META: StrategyManifestMeta = {
  id: 'ambient_x', version: '0.1.0', name: 'Ambient', summary: 's', rationale: 'r',
  paramsSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  capabilities: { platformSdk: true }, dataNeeds: { closedCandlesUpToCurrent: true }, hooks: ['onBarClose'],
};

export class AmbientBuilder implements StrategyBuilder {
  readonly adapter = 'ambient';
  readonly model = 'ambient';
  async build(_i: StrategyBuilderInput): Promise<StrategyBuilderOutput> {
    return { source: AMBIENT_SOURCE, manifestMeta: AMBIENT_META };
  }
}
```

- [ ] **Step 2: Тесты L2 + failClosed + maxIters**

Добавить в `src/proof/builder-proof-loop.test.ts`:

```ts
import { AmbientBuilder } from './builder-proof-loop.fixtures.ts';

it('L2 reject (ambient) → validation-feedback, prover не вызывается, исчерпание maxIters', async () => {
  let proverCalls = 0;
  const prover: BundleProverPort = { async prove() { proverCalls += 1; return { proven: true }; } };
  const outcome = await runBuilderProofLoop({ builder: new AmbientBuilder(), prover, input: INPUT, maxIterations: 3 });
  expect(outcome.proven).toBe(false);
  expect(outcome.attempts).toBe(3);
  expect(proverCalls).toBe(0); // L2 отсекает до платформенного prove
  expect(outcome.lastViolations).toContain('forbidden_ambient_authority');
});

it('platform failClosed → validation-feedback, до исчерпания', async () => {
  const builder = new RecordingBuilder();
  const outcome = await runBuilderProofLoop({
    builder,
    prover: new ScriptedProver([
      { proven: false, failClosed: { reason: 'runtime_error:boom' } },
      { proven: true },
    ]),
    input: INPUT,
  });
  expect(outcome.proven).toBe(true);
  expect(outcome.attempts).toBe(2);
  expect(builder.feedbacks[1]).toEqual({ kind: 'validation', violations: ['runtime_error:boom'] });
});

it('исчерпание maxIters при стойком divergence → proven:false + lastVerdict', async () => {
  const div: ProofVerdict = { proven: false, divergence: { bar: 1, field: 'qty', expected: 1, actual: 2 } };
  const outcome = await runBuilderProofLoop({
    builder: new FakeStrategyBuilder(),
    prover: new ScriptedProver([div, div]),
    input: INPUT,
    maxIterations: 2,
  });
  expect(outcome.proven).toBe(false);
  expect(outcome.attempts).toBe(2);
  expect(outcome.lastVerdict).toEqual(div);
});
```

- [ ] **Step 3: Прогнать — PASS**

Run: `npx vitest run src/proof/builder-proof-loop.test.ts`
Expected: PASS (все сценарии; реализация из Task 2 уже покрывает их).

- [ ] **Step 4: Коммит**

```bash
git add src/proof/builder-proof-loop.fixtures.ts src/proof/builder-proof-loop.test.ts
git commit -m "test(proof): L2 reject / failClosed→validation / maxIters-исчерпание"
```

---

### Task 5: Реальный shell-адаптер (prove_bundle.mjs)

**Files:**
- Create: `src/proof/shell-bundle-prover.ts`
- Test: `src/proof/shell-bundle-prover.test.ts`

**Interfaces:**
- Consumes: `BundleProverPort`, `ProofVerdict` (Task 2).
- Produces: `createShellBundleProver(opts: { cli: string }): BundleProverPort`.

- [ ] **Step 1: Тест против stub-CLI**

`src/proof/shell-bundle-prover.test.ts` (stub-CLI имитирует платформенный контракт: пишет вердикт в `--out`, exit 0):

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShellBundleProver } from './shell-bundle-prover.ts';

function writeStubCli(dir: string, verdict: object): string {
  const cli = join(dir, 'stub-cli.mjs');
  writeFileSync(cli,
    `import { writeFileSync } from 'node:fs';\n` +
    `const out = process.argv[process.argv.indexOf('--out') + 1];\n` +
    `writeFileSync(out, ${JSON.stringify(JSON.stringify(verdict))});\n`);
  return cli;
}

describe('createShellBundleProver', () => {
  it('шеллит CLI, парсит записанный вердикт', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbp-'));
    try {
      const cli = writeStubCli(dir, { proven: false, divergence: { bar: 7, field: 'qty', expected: 1, actual: 2 } });
      const prover = createShellBundleProver({ cli });
      const v = await prover.prove('export default function createStrategyModule(){ return {}; }');
      expect(v).toEqual({ proven: false, divergence: { bar: 7, field: 'qty', expected: 1, actual: 2 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Прогнать — FAIL**

Run: `npx vitest run src/proof/shell-bundle-prover.test.ts`
Expected: FAIL — `createShellBundleProver` не определён.

- [ ] **Step 3: Реализация**

`src/proof/shell-bundle-prover.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';

/**
 * Real-адаптер: шеллит платформенный proof-seam (trading-platform 050 prove_bundle.mjs).
 * `cli` — абсолютный путь к prove_bundle.mjs (вызывающий резолвит из PLATFORM_REPO_PATH).
 * exit≠0 = опер-сбой CLI → throw (инфра, не вердикт). Любой записанный вердикт → парсится.
 */
export function createShellBundleProver(opts: { readonly cli: string }): BundleProverPort {
  return {
    async prove(bundleSource: string): Promise<ProofVerdict> {
      const dir = mkdtempSync(join(tmpdir(), 'proof-'));
      const bundlePath = join(dir, 'bundle.mjs');
      const outPath = join(dir, 'verdict.json');
      try {
        writeFileSync(bundlePath, bundleSource);
        const res = spawnSync('node', [opts.cli, '--bundle', bundlePath, '--out', outPath], { encoding: 'utf8' });
        if (res.status !== 0) {
          throw new Error(`prove_bundle CLI опер-сбой (exit ${res.status}): ${res.stderr ?? ''}`);
        }
        return JSON.parse(readFileSync(outPath, 'utf8')) as ProofVerdict;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
```

- [ ] **Step 4: Прогнать — PASS**

Run: `npx vitest run src/proof/shell-bundle-prover.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/proof/shell-bundle-prover.ts src/proof/shell-bundle-prover.test.ts
git commit -m "feat(proof): shell-адаптер createShellBundleProver (prove_bundle.mjs)"
```

---

### Task 6: Gated real-LLM eval (ВНЕ vitest)

Заземление: реального factory для F2a `MastraStrategyBuilder` ещё нет (старый `real-builder-factory` использует `MastraBuilder`). Эта задача wired реальный strategy-builder через `composeMastra` + `createStrategyBuilderAgent` (закрывает F2a carry-over M5) и гоняет петлю против реальной платформы. Eval ПЕЧАТАЕТ `ProofOutcome` — НЕ ассертит `proven` (байт-идентичная paper-проекция от LLM — эмпирический исход).

**Files:**
- Create: `scripts/prove-builder-loop.mts`

**Interfaces:**
- Consumes: `composeMastra` (`src/mastra/compose-mastra.ts`), `createStrategyBuilderAgent` (`src/mastra/agents/strategy-builder.agent.ts`), `MastraStrategyBuilder` (`src/adapters/builder/mastra-strategy-builder.ts`), `createShellBundleProver` + `runBuilderProofLoop` (Tasks 2/5), замороженный `src/adapters/builder/fixtures/long-oi-profile.json`.
- Produces: исполняемый eval-скрипт (manual run, не в `pnpm check`).

- [ ] **Step 1: Скрипт eval**

`scripts/prove-builder-loop.mts` (точные конструкторы `MastraStrategyBuilder`/`createStrategyBuilderAgent` свериться с их файлами — F2a, в main; ниже — каноническая форма):

```ts
/**
 * Gated real-LLM eval (ВНЕ vitest): реальный MastraStrategyBuilder + shell prove_bundle.mjs +
 * замороженный long_oi-профиль → runBuilderProofLoop против реальной СОБРАННОЙ платформы.
 * Печатает ProofOutcome. Запуск:
 *   PLATFORM_REPO_PATH=/abs/path/trading-platform \
 *   MODEL_PROVIDER=openrouter ...ключи... \
 *   npx -y tsx scripts/prove-builder-loop.mts
 * Предусловие: в платформе выполнен `npm run build` (CLI грузит dist).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runBuilderProofLoop } from '../src/proof/builder-proof-loop.ts';
import { createShellBundleProver } from '../src/proof/shell-bundle-prover.ts';
import { composeMastra } from '../src/mastra/compose-mastra.ts';
import { createStrategyBuilderAgent } from '../src/mastra/agents/strategy-builder.agent.ts';
import { MastraStrategyBuilder } from '../src/adapters/builder/mastra-strategy-builder.ts';

const platformRepo = process.env.PLATFORM_REPO_PATH ?? resolve(process.cwd(), '../trading-platform');
const cli = join(platformRepo, 'scripts/prove_bundle.mjs');

const profileFixture = JSON.parse(
  readFileSync(new URL('../src/adapters/builder/fixtures/long-oi-profile.json', import.meta.url), 'utf8'),
);

// 1) Реальный билдер через composeMastra (закрывает F2a M5 wiring).
const env = process.env as unknown as Parameters<typeof composeMastra>[0];
const mastra = composeMastra(env);
const agent = createStrategyBuilderAgent({ /* model/authoringDoc — по сигнатуре F2a */ } as never);
const builder = new MastraStrategyBuilder({ agent } as never); // свериться с конструктором F2a

const input = {
  spec: { goal: 'long oi rebound (proof)' },
  authoringDoc: '', // взять реальный authoring-doc, как в author-strategy-bundle-пути
  profile: profileFixture,
} as never;

const outcome = await runBuilderProofLoop({
  builder,
  prover: createShellBundleProver({ cli }),
  input,
  maxIterations: 5,
});

// eslint-disable-next-line no-console
console.log('[prove-builder-loop] outcome:', JSON.stringify(outcome, null, 2));
```

(Реализатор: свериться с реальными сигнатурами `createStrategyBuilderAgent` / `MastraStrategyBuilder` constructor / `composeMastra` env-типом в файлах F2a и заполнить `agent`/`authoringDoc`/`spec` корректно. Это единственная задача без TDD-гейта — eval, проверяется ручным прогоном.)

- [ ] **Step 2: Дымовой ручной прогон (опционально, требует .env + собранную платформу)**

Run:
```bash
cd <platform-repo> && npm run build
cd <lab-worktree> && set -a && source <lab-main>/.env && set +a \
  && PLATFORM_REPO_PATH=<abs platform> npx -y tsx scripts/prove-builder-loop.mts
```
Expected: печатается `ProofOutcome` (`proven` ∨ `divergence`/`attempts`). Любой исход — валидный результат eval.

- [ ] **Step 3: Коммит**

```bash
git add scripts/prove-builder-loop.mts
git commit -m "feat(proof): gated real-LLM eval prove-builder-loop (wire F2a builder + shell prover)"
```

---

### Финал: регресс

- [ ] **Прогнать `pnpm check`** — vitest зелёный (proof-тесты герметичны; eval `.mts` вне глобов). Зафиксировать EXIT=0 в финальном отчёте.

## Self-Review

**Spec coverage:** design §Архитектура (порт/адаптер/петля) → Tasks 2/5; §Feedback-маппинг → Task 2 `verdictToFeedback` + Task 4; §Тест-стратегия (mechanism) → Tasks 3/4; §real-LLM eval → Task 6; §Прерогатива №1 → Task 1; §Границы (не трогать F1, без подписи) → Global Constraints. Все секции покрыты.

**Placeholder-скан:** код полный во всех TDD-задачах. Task 6 (eval, не TDD-гейт) содержит явные `свериться с F2a` пометки на 3 конструкторах — это намеренно (eval wired реальные F2a-символы, чьи точные сигнатуры реализатор подтверждает в их файлах; не плейсхолдер логики, а ссылка на существующие определения).

**Type consistency:** `ProofVerdict` (Task 2) консистентно используется в Tasks 3/4/5; `runBuilderProofLoop`/`ProofOutcome`/`BundleProverPort`/`createShellBundleProver` — имена стабильны между задачами; `verdictToFeedback` производит ровно `BuildFeedback` (`{kind:'parity',diff}` / `{kind:'validation',violations}`), форма `diff` идентична `ProofVerdict.divergence`.
