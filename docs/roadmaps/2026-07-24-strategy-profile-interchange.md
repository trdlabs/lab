# strategy-profile-interchange — локальная зона lab

Дата: 2026-07-24. Статус: `proposed` — код не начат; канонический план и
кросс-репо состояние — в карточке control-center
`docs/delivery/initiatives/strategy-profile-interchange.md`
(источник — отчёт `docs/analysis/16-strategy-profile-interchange.md`).

## Зона ответственности lab

Lab — владелец схемы профиля (`source_of_truth_repo` карточки). Локально
инициатива затрагивает:

- **SP-2 — `strategy-profile-v2`**: эволюция `AnalystProfileOutputSchema`
  (`src/domain/strategy-profile.ts`) — entry/exit как condition triples с
  AND/OR-группировкой (свободный текст остаётся рядом аннотацией),
  triple-barrier объект риска, секции universe/timeframes, типы и границы
  у `parameters`, provenance. Эпистемические поля
  (`confidence`/`unknowns`/`evidence`) сохраняются. Тянет одной волной:
  аналитика (`src/adapters/analyst/mastra-strategy-analyst.ts`, промпт
  `strategy-analyst.agent.ts`), критика, фикстуры и гейты харнесса
  (`src/experiments/strategy-analyst/`), RAG-индексацию. v1-профили
  остаются читаемыми (`contractVersion` различает).
- **Контракт source bundle** для `StrategyAnalystInputSchema`
  `kind: 'crawler'` (сейчас `content` — просто строка): нормализованное
  сырьё внешнего ресёрчера (транскрипт, извлечённый код, цитаты,
  метаданные источника).
- **SP-3/SP-4** (потребление схемы из shared-пакета; A2A-шов) — вне
  локальной зоны до решений владельца, см. карточку.

## Локальный статус и координация

Не начато; старт SP-2 — только после согласования спеки SP-1
(control-center). Координационное ограничение: onboarding-батарея
`research-validation-hardening` (items 5–6, волна 3) гоняет тот же
пайплайн `strategy.onboard` и его фикстуры — SP-2 не вести независимой
сессией одновременно с ней (либо после, либо одной сессией).
