# F2b — LLM Builder Proof Loop (design)

**Date**: 2026-06-28
**Branch**: `feat/llm-builder-proof-loop`
**Status**: design (awaiting review)

## Контекст

F2a (`MastraStrategyBuilder`, PR #97, в main) — постоянный LLM-билдер: `StrategyBuilderInput {spec, authoringDoc, profile, feedback?}` → StrategyModule-манифест. F2b замыкает **доказательство билдера**: итеративная петля, которая авторит бандл и доказывает, что его платформенная paper-проекция `== curated long_oi`, итерируя по структурному feedback'у до сходимости.

Платформенная половина готова: trading-platform 050 (`scripts/prove_bundle.mjs --bundle --out`) → вердикт `{proven} | {divergence:{bar,field,expected,actual}} | {failClosed:{reason}}`, форма выровнена с lab `BuildFeedback`. F2b — потребитель этого seam'а (прямой lab→platform, без подписи/admission).

## Решения (brainstorming 2026-06-28)

1. **Природа** — временный **сепарабельный proof-харнесс** (`src/proof/`), НЕ прод-оркестратор; ретайрится отдельно, не вмешивается в F1 `authorStrategyBundleHandler` (backtester-путь — отдельный).
2. **LLM-режим** — **mock-механизм** в петле/тестах (детерминированный fake-билдер) + **real-LLM как отдельный gated eval** (зеркало F2a regen). Герметичный тест доказывает МЕХАНИЗМ петли; реальный LLM-прогон — вне `pnpm check`.
3. **Fake-билдер** — демонстрирует **сходимость**: attempt 1 → divergence, после parity-feedback → proven (re-prompt реально меняет выход).
4. **Терминация** — `maxIterations` конфиг (дефолт 5); исчерпание → `ProofOutcome{proven:false, lastDivergence/violations, attempts}` (без исключения).
5. **Вход** — замороженный `long-oi-profile.json` (F2a fixture; детерминизм).

## Архитектура

### Порт `BundleProverPort`
```ts
type Verdict =
  | { proven: true }
  | { proven: false; divergence: { bar: number; field: string; expected: unknown; actual: unknown } }
  | { proven: false; failClosed: { reason: string } };

interface BundleProverPort {
  prove(bundleSource: string): Promise<Verdict>;
}
```
Форма `Verdict` 1:1 с платформенным 050. `divergence` ≡ `BuildFeedback['parity']['diff']`.

### Real-адаптер `shellBundleProver`
- Пишет `bundleSource` во временный файл, шеллит `node <cli> --bundle <f> --out <verdict.json>`, читает+парсит вердикт, чистит temp.
- `cli` = `${PLATFORM_REPO_PATH}/scripts/prove_bundle.mjs`; `PLATFORM_REPO_PATH` env, dev-default sibling `../trading-platform` (resolve от корня lab-репо). Платформа должна быть собрана (`npm run build`) — eval-скрипт это документирует/проверяет.
- exit≠0 (опер-сбой CLI) → бросает (это инфра-ошибка, не вердикт); любой записанный вердикт → парсится.

### Петля `runBuilderProofLoop`
```ts
interface ProofOutcome {
  proven: boolean;
  attempts: number;
  lastVerdict?: Verdict;          // последний не-proven вердикт при исчерпании
}

async function runBuilderProofLoop(deps: {
  builder: StrategyBuilder;
  prover: BundleProverPort;
  input: StrategyBuilderInput;     // spec + authoringDoc + frozen profile
  maxIterations?: number;          // default 5
}): Promise<ProofOutcome>;
```
Итерация:
1. `out = await builder.build({ ...input, feedback })` (L1 schema-retry — внутри builder).
2. `bundle = assembleStrategyBundle(out)` + **L2** `validateStrategyBundle(bundle)`:
   - invalid → `feedback = { kind:'validation', violations }` → continue.
3. `verdict = await prover.prove(bundle.source)` (L3 платформенный paper-паритет):
   - `proven` → return `{proven:true, attempts}`.
   - `divergence` → `feedback = { kind:'parity', diff: verdict.divergence }` → continue.
   - `failClosed` → `feedback = { kind:'validation', violations:[verdict.failClosed.reason] }` → continue.
4. Исчерпание `maxIterations` → `{proven:false, attempts, lastVerdict}`.

### Feedback-маппинг (ровно сёмы F2a-порта)
| Источник | BuildFeedback |
|---|---|
| L2 `validateStrategyBundle` violations | `{kind:'validation', violations}` |
| L3 platform `failClosed.reason` | `{kind:'validation', violations:[reason]}` |
| L3 platform `divergence` | `{kind:'parity', diff: divergence}` |

## Прерогатива №1 — fix-first

До real-LLM eval: сериализовать `profile.evidence`/`confidence` в `buildStrategyUserMessage` (carry-over №1 из F2a `.superpowers/sdd/deferred-minors.md`) — evidence несёт дословные исходные цитаты, confidence=0.92 — load-bearing grounding для сходимости реального LLM. Изолированный мелкий fix + обновление user-message теста.

## Тест/eval-стратегия

- **Герметичный** `src/proof/builder-proof-loop.test.ts`: fake-prover (attempt1→divergence, attempt2→proven) + fake-билдер (проксирует feedback без изменения выхода) → `proven:true` за 2 итерации; ассерт что feedback прокинут на 2-й `build`. Сходимость скриптуется фейковым ПРОВЕРОМ, не билдером. Плюс лёгкая unit-ассерта feedback-маппинга L2/failClosed→validation (без полного второго сценария). Плюс maxIters-исчерпание → `{proven:false, attempts}`.
- **Gated real-LLM eval** `scripts/prove-builder-loop.mts` (вне vitest): реальный `MastraStrategyBuilder` (composeMastra, openrouter .env) + `shellBundleProver` + замороженный long_oi-профиль → гоняет петлю против реальной собранной платформы; печатает ProofOutcome. Не в `pnpm check`.

## Границы

- НЕ трогаю `authorStrategyBundleHandler` (F1 backtester-путь отдельный).
- НЕ подпись/admission/HTTP (прямой lab→platform CLI).
- НЕ новый прод-оркестратор — `src/proof/` сепарабелен.
- Вход = замороженный long_oi-профиль; LLM-генерация реальна только в gated eval.

## Файлы (ориентир)

```
src/proof/
├── bundle-prover.port.ts          # BundleProverPort + Verdict
├── shell-bundle-prover.ts         # real-адаптер (shell prove_bundle.mjs)
├── builder-proof-loop.ts          # runBuilderProofLoop + feedback-маппинг
└── builder-proof-loop.test.ts     # герметичный mechanism-тест
scripts/prove-builder-loop.mts     # gated real-LLM eval
src/adapters/builder/strategy-user-message.ts  # +evidence/confidence (carry-over №1)
```
