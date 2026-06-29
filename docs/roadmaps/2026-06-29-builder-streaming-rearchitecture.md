# Roadmap: re-architect the strategy builder to unlock cheaper LLM models

**Date:** 2026-06-29
**Status:** backlog (separate F2a work)
**Origin:** model-selection bench (builder-proof, #long-oi)

## Проблема

`MastraStrategyBuilder` просит у LLM **весь бандл одним structured-output**: manifest + полный
исходник стратегии (~22KB кода) внутри одного JSON-объекта (`StrategyLlmOutputSchema`). Это
объективно тяжёлый вывод — надёжно тянут только сильные модели (**gpt-5.5**, **sonnet-4.6**).

## Доказательство (бенч 2026-06-29)

При фиксированном аналитике gpt-5.5 (эталонный профиль) каждый из 8 дешёвых топ-кодеров OpenRouter
как **билдер** провалился — даже с лимитом вывода 32768 и переиспользованием готового профиля:

| Билдер | $/1M out | Исход |
|---|---|---|
| deepseek-v4-flash / hy3-preview | $0.18 / $0.21 | `Unexpected end of JSON input` (обрезка) |
| mimo / glm-4.7-flash / deepseek-v4-pro / minimax-m3 / glm-5.2 / gpt-5-codex | $0.28–$10 | schema-parse fail (невалидный structured-output) |
| **sonnet-4.6** | $15 | ✅ все 11 символов byte-identical (finish=stop) |
| gpt-5.5-pro | $180 | ✅ baseline |

Порог = сила модели на **большом** structured-output. Текущий рекомендованный сетап:
аналитик gpt-5.5 + билдер **sonnet-4.6** (12× дешевле gpt-5.5 именно на самом дорогом шаге).

## Идея ре-архитектуры

Не гнать весь исходник одним structured-output, чтобы вывод на каждый вызов был маленьким и
дешёвые модели справлялись с чанками. Варианты (любой ∨ комбинация):

1. **Разделить manifest и source.** Сначала structured-output только manifest (маленький), затем
   source отдельным free-form (не-structured) вызовом — парсинг кода не требует JSON-схемы.
2. **Чанкование source.** Генерировать исходник по секциям (helpers / onBarClose / onPositionBar /
   exit-predicates) и собирать — каждый вызов укладывается в лимит.
3. **Не-structured source.** Source как обычный текст в code-fence (zod-схема только на manifest);
   убирает «весь код в одном JSON-поле».

## Приёмка

Тот же round-trip / all-trades паритет (`scripts/code-analyst-roundtrip.mts` +
платформенный `prove_bundle`), но с дешёвым билдером (deepseek-v4-flash / hy3 / mimo): byte-identical
по всем символам снапшота. Цель — сбить стоимость билдера ниже sonnet-4.6 ($15/1M), сохранив паритет.

## Связанное

- Фикс провайдер-портабельности схемы (`capabilities`/`dataNeeds` → JSON-string, ≤16 unions) —
  PR `feat/builder-schema-portable` (разблокировал Anthropic/sonnet; предпосылка к этому roadmap).
