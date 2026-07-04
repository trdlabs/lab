# Slice G3 — Strategy Revisions: детерминированное слияние proxy-passed гипотез + стекинг раундов

**Date:** 2026-07-03
**Status:** APPROVED — секции согласованы в диалоге (гибрид; батч; greedy-деградация; acceptance через strategy-lane) + 4 правки текстового ревью внесены (bootstrap revision v1, терминология proxy≠proven с жёстким инвариантом, same-run-context гарантия для сравнения, однозначный score tie-break). Готово к writing-plans.
**Parent:** roadmap §8 гап G3; поверх G1 (strategy-lane, bundleArtifactRef, reconstructStrategyBundle), G2b/G4.

## 0. Контекст и мотивация

Сегодня топология гипотез — «звезда от baseline»: каждый оверлей валидируется поодиночке против исходной стратегии, вердикт бэктеста НЕ возвращается на `HypothesisProposal`, объединения нет, `activeOverlayRules` подаёт researcher'у schema-validated (не proven) правила. Плюс pre-existing мисматч: реальный overlay-ран идёт против trusted `short_after_pump` (единственный preset бэктестера), а не против улучшаемой стратегии.

G3 вводит сущность «ревизия стратегии», детерминированное слияние proxy-passed гипотез, честный acceptance-гейт через strategy-lane и стекинг раундов N+1 поверх принятой ревизии.

## 1. Сущность `strategy_revision` (аддитивная миграция)

`strategy_revision`: id PK, strategy_profile_id NOT NULL, version int NOT NULL (монотонный на профиль), base_revision_id text NULL (цепочка; NULL = ревизия №1 от исходного baseline), hypothesis_ids jsonb NOT NULL (вошедшие), dropped jsonb NULL (массив `{hypothesisId, reason: 'merge_conflict_dropped'|'combo_fail_dropped', detail}` — каждый исключённый объясним), merged_rule_set jsonb NOT NULL, bundle_artifact_ref jsonb NULL (ArtifactRef собранного revision-СТРАТЕГИЯ-бандла), combo_backtest_run_id text NULL (strategy-lane ран), status text NOT NULL (`candidate|accepted|rejected`), metrics jsonb NULL, verdict_reason text NULL, created/updated. UNIQUE(strategy_profile_id, version).

Порт `StrategyRevisionRepository`: create / findLatestAccepted(profileId) / findById / updateStatus / listByProfile.

**Bootstrap revision v1 (правка ревью — без неё первый revision.build не имеет базы сравнения).** При завершении G1 baseline-эксперимента (и backfill для уже существующих завершённых baseline'ов) создаётся `strategy_revision` версии 1: `status='accepted'`, `baseRevisionId=null`, `hypothesisIds=[]`, `bundleArtifactRef = baseline.bundleArtifactRef`, `comboBacktestRunId = strategyBacktestRunId` holdout-member'а (fallback sanity), `metrics = ` метрики этого рана. Идемпотентно (UNIQUE(profileId, version)); точка создания — финализация `runStrategyBaselineValidation` + backfill-ветка в `revision.build` (если accepted-ревизии нет, а завершённый baseline-эксперимент есть — создать v1 на месте).

## 2. Детерминированный merger + composition harness (БЕЗ LLM в core path)

**Вход:** упорядоченный список proxy-passed гипотез цикла, eligible for revision batch (порядок = score, §4) с их overlay-модулями (LLM-собраны ранее, чистый код без импортов, hook `apply`) и структурированными `ruleAction`.

**Конфликт-детект (до кодогенерации):** на уровне структурированных правил — две гипотезы задают противоречивые значения одному параметру/условию (`appliesTo`+param key match с несовместимыми значениями) → деterministically побеждает лучшая по score; проигравшая → `dropped: merge_conflict_dropped` (+ событие).

**Composition harness — семантика, НЕ конкатенация.** Правка пользователя: raw-concat в общий scope запрещён. Harness:
- каждый overlay-модуль изолируется в собственный namespace (IIFE/фабрика; никакого разделяемого scope между модулями);
- фиксированный детерминированный порядок применения (= score-порядок; персистится в merged_rule_set);
- семантика композиции повторяет движковый OverlayComposer: цепочка `pass | annotate | patch | veto`, veto терминален, patch перезаписывает решение;
- конкатенация исходников допустима только как packaging detail внутри harness-шаблона.

**Выход — два артефакта:**
1. **Revision-СТРАТЕГИЯ-бандл** (kind:'strategy'): исходник базы (base = latest accepted revision's bundle, для v1 — исходный baseline-бандл через `reconstructStrategyBundle(bundleArtifactRef)`) + harness, перехватывающий решения базовой стратегии и прогоняющий их через изолированные overlay-модули. Это САМОДОСТАТОЧНАЯ стратегия — гоняется через `engine:'strategy'` (G1-lane) без каких-либо изменений бэктестера.
2. merged_rule_set jsonb (для researcher-контекста и аудита).

Кодогенерация — чистая функция `composeRevisionBundle(baseSource, overlayModules[], order)`: шаблон + подстановка, никакого LLM. Инвариант тестом: композиция детерминирована (одинаковый вход → байт-идентичный выход → одинаковый bundleHash).

## 3. Acceptance path — ТОЛЬКО strategy-lane (правка пользователя)

- **Терминология (жёсткий инвариант, правка ревью):** результат overlay-lane — это **proxy-signal**, НЕ proof («proven» в отношении одиночной гипотезы в коде/событиях/доках запрещено). **Единственный proof активности = accepted `strategy_revision` после strategy-lane combo-валидации.** Individual гипотезы остаются в существующей overlay-lane как **proxy-валидация** (дёшево отсекает мусор), но proxy-PASS делает гипотезу лишь **eligible for revision batch**. Дельты-против-preset-baseline из этой lane — **временная diagnostic-метрика, НЕ основание принять ревизию**.
- **Батч в конце цикла** (все `hypothesis.build` цикла завершены): merger собирает candidate-ревизию как standalone strategy-бандл (§2).
- **Combo-подтверждение:** candidate-бандл через `engine:'strategy'` (существующий `StrategyExperimentRunExecutor`/G1-механика) на том же dataset/period/params.
- **Baseline сравнения = текущая accepted-ревизия** на **гарантированно том же run-context** (правка ревью): если у latest accepted-ревизии НЕТ comparable strategy-lane рана для текущего datasetScope/paramsHash — `revision.build` СНАЧАЛА прогоняет accepted-ревизию через `StrategyRevisionRunExecutor` на этом же run-context, сохраняет comparison-baseline-ран (на ревизии), и только потом гоняет candidate. Сравнение метрик из разных периодов/параметров запрещено by construction. Сравнение детерминированное (лестница в духе evaluateBacktest: ΔnetPnl, ΔmaxDrawdown, fragility). Этот доп-ран входит в бюджет ≤3+1 прогонов на цикл.
- PASS → `status='accepted'`, ревизия становится latest; FAIL → greedy-деградация (§4); исчерпано → `rejected`, причины в ledger.

## 4. Greedy-деградация и score (решение пользователя, дословно)

Score гипотезы (для порядка слияния, разрешения конфликтов и выбора «худшей» при деградации), лексикографически (правка ревью — однозначный порядок): (1) verdict rank desc; (2) netPnl delta desc; (3) maxDrawdown improvement desc; (4) createdAt desc; (5) hypothesisId asc. Если createdAt недоступен/ненадёжен на записи — пропускается, финальный tie-break всегда hypothesisId asc.

Combo-FAIL → bounded greedy: убрать худшую по score, пересобрать candidate-бандл, повторить strategy-lane бэктест. **Максимум 2 ретрая** (итого ≤3 combo-бэктеста на цикл — G3 не превращается в скрытый sweep). Пустой батч → ревизия не создаётся. Все причины — события + ledger.

Инварианты: слияние deterministic, LLM-арбитра в core path НЕТ (future assistant/debug mode); individually proxy-passed гипотеза НЕ active, пока не вошла в accepted-ревизию (см. терминологический инвариант §3).

## 5. Оркестрация

Новый task type `revision.build` (аддитивно в AGENT_TASK_TYPES): энкьюится, когда все hypothesis.build задачи цикла терминальны (триггер — из `backtestCompletedHandler`/цикл-финализации по correlationId: счётчик ожидаемых/завершённых; dedupeKey `revision.build:${correlationId}`). Handler: собрать proxy-passed гипотезы цикла (+ bootstrap v1 backfill-ветка, §1) → §2 merge → §3 strategy-lane подтверждение → §4 деградация → персист + события (`revision.candidate_built`, `revision.accepted`, `revision.rejected`, `revision.hypothesis_dropped`).

**Шов под будущий handoff (правка пользователя):** прогон candidate-ревизии изолируется портом **`StrategyRevisionRunExecutor`** — сейчас единственная реализация делегирует в G1 strategy-lane; когда бэктестер получит native overlay-on-submitted-baseline (handoff-док, вне scope), появится вторая реализация без изменения handler'а.

## 6. Фидбек вердиктов + researcher-вход

- `HypothesisProposal` += статусные переходы (терминология §3 — proxy, не proven): `validated → proxy_passed | proxy_failed | proxy_paper_candidate` (из backtestCompletedHandler, overlay-lane) и `→ merged | dropped_merge_conflict | dropped_combo_fail` (из revision.build). Аддитивная миграция + repo-метод updateStatus.
- `activeOverlayRules` для researcher = merged_rule_set **последней accepted-ревизии** (не schema-validated пул). Нет accepted-ревизии → пусто.
- Гипотезы раунда N+1: билдер получает конtext accepted-ревизии; их proxy-валидация — как раньше (overlay-lane); их батч сольётся уже с base = latest accepted revision artifact (§2).

## 7. Вне scope G3 (зафиксировано пользователем)

- LLM-консолидация ревизии в чистый исходник на промоушен-точках (G3b; с обязательным re-baseline через полный G1-контур).
- Paper-мост ревизии (перевешивание paper-кандидата на accepted-ревизию).
- Handoff бэктестеру: native overlay-on-submitted-baseline + мульти-overlay-бандлы (третий handoff-док — пишется в G3 как документ, реализация платформенной стороной; G3 совместим через порт §5).

## 8. Тесты (контур)

1. Merger: конфликт-детект (противоречивые params → лучший score побеждает, dropped объясним); порядок слияния = score; детерминизм (байт-идентичный бандл при повторе).
2. Harness: изоляция namespace (модуль не видит символы другого); семантика pass/annotate/patch/veto эквивалентна движковой (табличные кейсы); veto терминален.
3. Revision-бандл: валидный kind:'strategy' бандл (validateBundle), исполним strategy-lane (integration с fake-executor).
4. revision.build: триггер после всех hypothesis.build; greedy-деградация max 2; пустой батч; ledger/события; повторный запуск идемпотентен (dedupe + существующая candidate/accepted).
5. Статусы HypothesisProposal: переходы из обоих handlers; аддитивные миграции.
6. activeOverlayRules: только accepted-ревизия; нет ревизии → пусто (regression: schema-validated больше НЕ подаются).
7. N+1: батч с base=accepted-ревизией (цепочка base_revision_id).

## 9. Риски

- Harness-эмуляция OverlayComposer может разойтись с движковой семантикой на краях (annotate-merge, patch-schema) — закрывается табличными тестами, скопированными из движковых кейсов; при расхождении — приоритет native handoff.
- Триггер «все hypothesis.build цикла завершены» требует надёжного счётчика по correlationId — реализация через существующий task-репозиторий (подсчёт задач цикла в терминальных статусах), не отдельное состояние.
- Combo-бэктест на strategy-lane дороже overlay-прогона (полный ран) — ограничение ≤3/цикл принято пользователем.
