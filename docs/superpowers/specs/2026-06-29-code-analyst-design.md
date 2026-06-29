# Design: code→profile analyst (`bot_code` analysis)

**Date:** 2026-06-29
**Branch:** `feat/code-analyst`
**Status:** approved (brainstorming)
**Scope:** per-kind prompt branching in the existing analyst + multi-file code input helper + gated round-trip validation

## Контекст / Problem

Аналитик lab превращает источник стратегии в `StrategyProfile` (вход для билдера). Сейчас он принимает только текст эффективно: `SOURCE_KINDS` включает `bot_code`, но `MastraStrategyAnalyst` строит **один generic-промпт** для всех kinds, а `INSTRUCTIONS` агента общие. Поэтому код обрабатывается как обычный текст → headline-профиль без тонких гейтов.

F2b-де-риск (2026-06-29) показал: **полнота профиля — главный рычаг**. Вручную обогащённый профиль (17 точных гейтов curated long_oi: warmup=30, OI-recovery≥0.05%, liq≥$10&≥0.02%OI, dump-качество, fastBounce=2.5%) → LLM-бандл входит на **bar 63** vs curated **64** (было bar 30 на headline-профиле). NL-профиль намеренно lossy; ручное обогащение — хак.

**Нужен механизм:** на вход — КОД стратегии (возможно multi-file), на выход — ТОЧНЫЙ профиль со всеми гейтами/формулами. Читая реальный код, аналитик может извлечь точные формулы (а не прозу) → потенциально закрыть последний бар → byte-identical.

## Решения (brainstorming 2026-06-29)

1. **Один аналитик, ветвление промпта по kind** (не отдельный агент, не мега-промпт). Аналитик делает одно — профиль; но `bot_code` → code-analysis промпт, текст → текстовый промпт, чтобы каждый запрос нёс только релевантные инструкции (экономия токенов).
2. **`bot_code` уже существует** в `SOURCE_KINDS` — новый input-kind НЕ заводим.
3. **Multi-file = конкатенация в `content`** с маркерами `// ===== FILE: <path> =====`. Схема входа (`content: string`) НЕ меняется; LLM видит границы файлов.
4. **Выход `StrategyProfile` неизменен** — downstream builder не трогаем.
5. **Де-риск пройден** (ручное обогащение → bar 63) — направление оправдано.

## Архитектура

### 1. Multi-file input helper

`src/domain/code-source.ts`:
```ts
export interface CodeFile { readonly path: string; readonly content: string }
/** Конкатенация файлов в единый source-блок с явными границами для LLM. */
export function buildCodeSource(files: readonly CodeFile[]): string;
// → "// ===== FILE: <path> =====\n<content>\n\n// ===== FILE: ... =====\n..."
```
Плюс удобный читатель (для валидации/будущего) `src/adapters/code-source/read-code-dir.ts`: `readCodeDir(dir, globs): CodeFile[]` (детерминированный порядок по path). Покрывает: один файл, директория, git-subdir. Результат → `analyze({ kind:'bot_code', content: buildCodeSource(files) })`.

### 2. Prompt branching (token-economy)

`MastraStrategyAnalyst.buildPrompt(input)` ветвится по `input.kind`:
- **`bot_code`** → code-analysis user-message:
  > "The SOURCE below is the COMPLETE implementation of a trading strategy (one or more files, each delimited by a `// ===== FILE: <path> =====` marker). Extract an EXACT, exhaustive profile: every parameter default, numeric threshold, window length, index offset, gate condition, and the precise comparison/formula. Capture fine-grained gates (warmup bar count, OI-recovery percent over N buckets, liquidation minima and liq/OI ratios, dump-quality filters, off-by-one indexing). Do NOT approximate or summarize — a builder must reproduce the EXACT runtime behavior from this profile. Put genuinely-absent details in `unknowns`."
- **текстовые kinds** → нынешний промпт (без изменений).
- Общая система-роль остаётся минимальной; kind-специфичные инструкции — в per-call user-message (только релевантные → экономия токенов). (Если Mastra поддержит per-call instruction-override — эквивалентно перенести в system; решаем при impl, поведение то же.)

### 3. Round-trip validation (gated, вне vitest)

`scripts/code-analyst-roundtrip.mts`: curated long_oi код (`${PLATFORM_REPO_PATH}/src/strategies/long_oi/*.ts` — поведенческие файлы: module/flat_phase/position_phase/signals/params/state) → `readCodeDir` → `buildCodeSource` → `analyze({kind:'bot_code'})` → wrap `AnalystProfileOutput` в `StrategyProfile` (как regen-скрипт F2a) → builder → бандл → платформенный `prove_bundle.mjs` vs curated. Печатает профиль + вердикт. Цель: ≥ bar 63 (паритет ручному обогащению), идеал — bar 64 / byte-identical. Один реальный LLM-вызов (token-economy). Не в `pnpm check`.

## Файлы (ориентир)

```
src/domain/code-source.ts                       # CodeFile + buildCodeSource
src/domain/code-source.test.ts                  # маркеры/порядок/edge
src/adapters/code-source/read-code-dir.ts       # readCodeDir(dir, globs)
src/adapters/code-source/read-code-dir.test.ts
src/adapters/analyst/mastra-strategy-analyst.ts  # buildPrompt — ветка bot_code (MODIFY)
src/adapters/analyst/mastra-strategy-analyst.test.ts  # bot_code→code-инструкции; текст→нет (MODIFY/ADD)
scripts/code-analyst-roundtrip.mts              # gated round-trip eval
```

## Тест / eval-стратегия

- **Герметично (vitest):** `buildCodeSource` (маркеры, детерминированный порядок, один/несколько файлов); `readCodeDir` (glob, сортировка); `buildPrompt` — `bot_code` несёт code-инструкции + НЕ несёт их для текстовых kinds (доказывает ветвление + token-economy); адаптер парсит `AnalystProfileOutput`.
- **Gated real-LLM:** `code-analyst-roundtrip.mts` (вне vitest; реальный gpt-5.5 + платформа собрана). Печатает профиль + вердикт; `proven` эмпиричен, НЕ ассертится.

## Границы

- Переиспользуем `bot_code` kind — без schema/контракт-изменений; `StrategyProfile`-выход неизменен.
- Текст-путь аналитика НЕ трогаем (ветка только добавляет `bot_code`-промпт).
- Вход = поведенческие файлы стратегии (передаёт вызывающий через `readCodeDir`/glob), не весь git-репо — иначе шум.
- НЕ меняем builder, проф-схему, prove-seam.

## Non-goals (YAGNI)

- НЕ авто-обход git-репо/клонирование — вход = список файлов/директория (git-subdir = вызывающий клонирует и указывает путь).
- НЕ новый агент/порт/адаптер — один аналитик, ветвление промпта.
- НЕ менять `SOURCE_KINDS`/fingerprint/dedupe (content остаётся строкой).
- НЕ автоматический re-prompt на остаточный off-by-one (отдельная будущая работа; round-trip сначала измеряет, насколько код→профиль точнее ручного).
