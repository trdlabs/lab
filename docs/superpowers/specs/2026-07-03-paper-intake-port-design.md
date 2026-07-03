# Paper-intake port — автономный триггер lab→platform (G2-инкремент)

**Дата**: 2026-07-03 · **Статус**: implemented · **Контекст**: roadmap G2 (2026-06-30-backtest-research-orchestrator-roadmap.md:222); платформа 062 принимает identity-поля (strategyName/side/params) в intake и производит запускаемые bot_bundle.

## Проблема

После `proven`-вердикта билдер-цикла (F2b) бандл никуда не уходит: `runBuilderProofLoop` возвращает `{proven, attempts}` без бандла, `PaperIntakePort` существует только в roadmap-доке. Платформенный intake уже готов принимать identity (аддитивные поля 062), без них promotion производит бандл с `metadata=null` (host его не запустит).

## Решение (три аддитивных шага)

1. **`ProofOutcome.bundle?`** — `runBuilderProofLoop` при proven возвращает собранный `AssembledStrategyBundle` (bytes/source/manifest/bundleHash). Аддитивно: существующие вызыватели не меняются.
2. **`src/adapters/platform/paper-intake.port.ts`**:
   - `buildPaperIntakeRequest(args)` — чистый маппер: `{bundle, identity{strategyName, side, params?}, evidence{baselineRunId, variantRunId, datasetRef, window, symbols, timeframe, metricsSnapshot, improvementSummary}}` → `PaperCandidateIntakeRequest` (SDK DTO + identity-поля поверх: SDK 0.9.0 их ещё не типизирует, платформа уже принимает — расширенный локальный тип, каст при отправке);
   - `side`: только `'long'|'short'` проходит в запрос (платформа не проецирует иное); `direction: both/unknown` → поле опускается + это ответственность вызывателя;
   - `createSdkPaperIntake({baseUrl, token?, fetchImpl?})` — адаптер поверх `submitPaperCandidate`+`createHttpIntakeTransport` (паттерн OpsReadClient);
   - `selectPaperIntake(env)` — `LAB_PAPER_INTAKE_URL`(+`LAB_PAPER_INTAKE_TOKEN`); без URL → `{enabled:false}`-стаб c логом (паттерн selectBotResults).
3. **`scripts/submit-paper-candidate.mts`** — вызываемый триггер (CLI): bundle-файл + identity/evidence-арги → submit; печатает `{ok, candidateId, admissionStatus}`. Оркестратор sweep подключит порт программно, когда появится (данные-staged 🔴); CLI закрывает ручной/скриптовый запуск цепочки уже сейчас.

## Evidence-маппинг (из experiment/ledger, когда вызывается программно)

`datasetScope.datasetId→datasetRef`, `member.periodFrom/To→window.fromMs/toMs`, `member.symbols`, `timeframe`, `member.resultSummary→metricsSnapshot`, `experiment.verdictReason→improvementSummary`, `member.backtestRunId` по ролям → baseline/variantRunId, `bundleHash→evidence.artifactRefs[0]` + `strategy.moduleBundleHash`.

## Тесты

vitest (колокация): маппер (полный/деградированный side/params), selectPaperIntake env-ветки, submit через fake-transport (identity-поля доезжают в body), proof-loop возвращает bundle при proven. Кросс-репо e2e — прогон CLI против реального платформенного intake (вне vitest, зафиксирован в отчёте фичи).
