# Slice 079 — Signed backtest evidence on paper-intake submissions

**Date:** 2026-07-04
**Status:** APPROVED — направление подтверждено пользователем (handoff + lab-consumer, БЕЗ lab-self-sign); 4 правки ревью внесены (1: fail-closed на 079-intake через LAB_PAPER_EVIDENCE_REQUIRED §4a; 2: fixture boot-guard NODE_ENV=test/LAB_ALLOW_FIXTURE_EVIDENCE §3; 3: vendored canonicalizer + требование SDK-экспорта в handoff §4.3/Deliverable A; 4: provide() принимает полный scope §3). Готово к writing-plans.
**Parent:** платформенная фича 079 (enforcement LIVE на VPS intake, handoff-док `2026-07-03-lab-signed-evidence-handoff.md` → main ee1cd05); поверх G2b paper-моста (PR #129) и G4.

## 0. Что требует платформа (079) и где мы сейчас

VPS-intake гоняет 043-верификатор: каждый `submitPaperCandidate` проверяется на подписанный evidence-артефакт (Ed25519, ключ бэктестера `bt-ed25519-cb1661aa4bcbfff8` в allowlist платформы). Матрица (fail-closed): нет артефакта → `quarantined`; невалидная подпись → `rejected evidence_signature_invalid`; `body.verdict!=='passed'` → `rejected backtest_not_passed`; `body.bundleHash≠sha256(bundle bytes)` → `rejected` (hash-pin); `body.{datasetRef,window,symbols,timeframe}≠evidence.{...}` → `rejected` (scope mismatch).

Сегодня `buildPaperIntakeRequest` шлёт `evidence.artifactRefs: [bundleHash]` без evidence-файла → **всякая отправка была бы quarantined**. In-flight ничего не ломается (LAB_PAPER_INTAKE_URL ещё не смотрит на VPS), но мост надо расширить до первого реального цикла.

## 1. Критический факт: 079 НЕ закрывается lab-only (обосновывает архитектуру)

Grounding-исследование (5 поверхностей, file:line в отчёте) показало:
- **Бэктестер НЕ отдаёт fetchable подписанный evidence для реального WFO-рана.** `signEvidence` — CLI-only (`apps/backtester/scripts/produce-evidence.mts`), подписывает ФИКСТУРУ (`TODO(real-bundle)`), нет `/v1/runs/{id}/evidence`, `/result` не несёт evidence-artifact-id. Strategy-lane run-результат (`RunResultSummary.evidence`) = seed/contractVersion, не подпись.
- **SDK-типа нет** ни в одном вендоренном пакете (форма живёт только внутри репо: `src/ports/backtester-strategy.port.ts:5`, backtester `evidence/body.ts:15`).
- **Доставки в inbox в коде lab нет** — внешний ssh/rsync; lab делает только локальный CAS-put.
- **Trust-модель запрещает lab-self-sign:** смысл подписи в том, что вердикт заверяет ДОВЕРЕННЫЙ бэктестер; лаб-подпись = «сам себе судья», проверка бессмысленна.

Вывод: несущая зависимость (подпись реального рана + fetch) — **backtester/platform-side**. Лаб строит консьюмер за швом и может проверить его на fixture/fake, но live-замыкание — после бэктестер-релиза.

## 2. Deliverable A — handoff-док бэктестеру

`docs/superpowers/specs/2026-07-04-backtester-sign-real-run-evidence-handoff.md` (структура как у платформенных handoff'ов в этой папке: Why / Current gap (file:line) / Change / Acceptance / Lab-side contract). Требование к бэктестеру:
1. **Подписывать РЕАЛЬНЫЙ ран** (не фикстуру): на завершении strategy/overlay-рана, дошедшего до `verdict==='passed'`, продюсить `SignedBacktestEvidence` над `buildEvidenceBody({backtesterRunId, bundleHash=sha256(поданных байтов бандла), verdict, datasetRef, window, symbols, timeframe, keyId})` ключом `BT_EVIDENCE_SIGNING_KEY`. Закрыть `TODO(real-bundle)` в `produce-evidence.mts` / встроить в run-pipeline (`signEvidence` сейчас без вызывателей).
2. **Отдать evidence fetchable**: либо evidence-artifact-id в `/v1/runs/{id}/result` (в `artifactRefs` или отдельным полем), либо новый `GET /v1/runs/{id}/evidence`. Lab-контракт: получить `SignedBacktestEvidence` JSON по завершённому `runId`.
3. **Scope-инвариант**: подписанный `body.{datasetRef,window,symbols,timeframe}` = ровно scope рана (иначе lab-submission не совпадёт и получит reject).
4. **Экспорт canonicalizer+типа (правка ревью 3)**: бэктестер/платформа ДОЛЖНЫ вынести `SignedBacktestEvidence` тип + `canonicalizeEvidenceBody` в consumable SDK, чтобы lab перестал держать vendored-копию (§4.3). До этого lab держит local copy с версией; при рассинхроне канонизации реальный evidence не проверится, хотя fixture проходит.

## 3. Deliverable B — lab-консьюмер за швом `SignedEvidenceProviderPort`

Порт (`src/ports/signed-evidence-provider.port.ts`) — provide принимает ПОЛНЫЙ scope (правка ревью 4: провайдеру scope нужен для HTTP-query/tracing/ошибок — сразу видно, какой evidence ожидается):
```ts
export interface SignedEvidenceProviderPort {
  readonly available: boolean;
  provide(args: {
    backtesterRunId: string;
    bundleHash: string;
    datasetRef: string;
    window: { from: string; to: string };
    symbols: string[];
    timeframe: string;
  }): Promise<SignedBacktestEvidence | null>;
}
```
`SignedBacktestEvidence` — переиспользуем существующий тип `src/ports/backtester-strategy.port.ts:5` (форма 079 точная).

Реализации (env-селектор `LAB_SIGNED_EVIDENCE_SOURCE`, boot-safe как select-bot-results):
- `none` (дефолт): `available=false`, `provide→null`. Мост работает по-старому (submit без evidence) — ТОЛЬКО для mock/local/non-079 intake. Для 079-enforced intake см. §4a (fail-closed).
- `fixture`: канонический fixture-подписанный артефакт (для тестов/demo, тот же ключ, что fake TRUSTED_SIGNERS). **Guard (правка ревью 2): разрешён ТОЛЬКО при `NODE_ENV==='test'` ИЛИ `LAB_ALLOW_FIXTURE_EVIDENCE==='true'`; иначе `selectSignedEvidence` boot-fail'ит** — иначе fixture-«зелёная кнопка» в реальном intake (fixture с mismatched bundleHash / обход смысла pipeline).
- `http` (после бэктестер-релиза): читает evidence из run-результата / `GET /v1/runs/{id}/evidence`. **В этом слайсе — тонкая заглушка, помеченная как «wire on backtester release»**; полноценно — follow-up после Deliverable A.

## 4. Интеграция в `paper.start` (§2 pre-flight verify + доставка)

### 4a. Fail-closed на 079-enforced intake (правка ревью 1)

`none`-source НЕ должен молча слать на 079-intake (гарантированный quarantine). Явный env `LAB_PAPER_EVIDENCE_REQUIRED` (default `false`; на VPS ставится `true`):
- `LAB_PAPER_EVIDENCE_REQUIRED=true` И `!services.signedEvidence.available` (source=none) → **boot-fail** в composition (`selectSignedEvidence`/composition guard: «evidence required but source=none»). Не даём подняться воркеру, который гарантированно наплодит quarantine.
- `LAB_PAPER_EVIDENCE_REQUIRED=true` И `provide→null` (source есть, но evidence не добыт) → `paper.evidence_required` + НЕ submit (fail-closed).
- `LAB_PAPER_EVIDENCE_REQUIRED=false` (non-079 intake) И `available=false` → старое поведение (submit без evidence).

### 4b. Основной поток

`paperStartHandler` (расширение, не переписывание) при `services.signedEvidence.available`:
1. После реконструкции бандла и `submitProvenCandidate`-подготовки: `evidence = await services.signedEvidence.provide({ backtesterRunId: variantRun.platformRunId, bundleHash, datasetRef, window, symbols, timeframe })` (scope = тот же, что buildChampionSubmission кладёт в evidence).
2. `null` → §4a: при `LAB_PAPER_EVIDENCE_REQUIRED=true` событие `paper.evidence_required {experimentId, reason}` + НЕ отправлять (fail-closed: не слать заведомо quarantine-заявку); ledger `submission_status` не пишется — эксперимент ждёт evidence. При `LAB_PAPER_EVIDENCE_REQUIRED=false` + `available=false` — старое поведение (submit без evidence, non-079 intake).
3. **Lab-side pre-flight verify** (`src/research/verify-signed-evidence.ts`, чистый): `verdict==='passed'`; `body.bundleHash===bundle.bundleHash` (hash-pin к нашим байтам); `body.{datasetRef,window,symbols,timeframe}` === scope нашей submission (тот же, что buildChampionSubmission кладёт в evidence); **Ed25519-verify** подписи (node `crypto.verify` над каноническими байтами body, ключ по `body.keyId` из lab-конфига TRUSTED_SIGNERS — hand-rolled, т.к. verify-fn не в SDK). **Canonical-контракт (правка ревью 3): lab обязан использовать ТОТ ЖЕ canonicalization, что бэктестер** (`canonicalizeEvidenceBody`). В этом слайсе — **vendored local copy** `canonicalizeSignedEvidenceBody` (перенос алгоритма из backtester `evidence/canonicalize`, с шапкой-ссылкой на источник + версией); **handoff (Deliverable A) ДОЛЖЕН требовать экспорт canonicalizer+тип из backtester/platform SDK следующим шагом** (чтобы lab перестал держать копию). Любое несовпадение любой проверки → `paper.evidence_rejected {reason}` + НЕ слать (локальный fail-fast вместо удалённого reject).
4. **CAS-доставка**: `evidenceRef = await services.artifacts.put(canonicalJson(evidence), {kind:'signed_backtest_evidence', mime_type:'application/json', producer:'paper-start-handler'})` → тот же локальный CAS, откуда внешний ssh/rsync метёт файл в inbox; имя файла = content-hash ref, который платформа резолвит.
5. **artifactRefs**: `evidenceRef` добавляется в `evidence.artifactRefs` submission'а. Механизм: `SubmitProvenCandidateArgs` (#127-порт) += опциональный `evidenceArtifactRef?: string`; `buildPaperIntakeRequest` (paper-intake.port.ts) при наличии добавляет его в `artifactRefs` (перед/после bundleHash — верификатор сканирует все refs). **Аддитивно** — #127-путь без evidence не меняется. Байтовый бандл-ref (G2b) остаётся.

## 5. Тесты
1. `verify-signed-evidence`: happy (валидная подпись+scope+hash+passed → ok); каждая ветка reject (tampered body→signature_invalid через РЕАЛЬНЫЙ Ed25519 с fake-ключом; verdict!=passed; hash-pin mismatch; каждый scope-филд mismatch). Ключевой negative-тест 079-acceptance.
2. `buildPaperIntakeRequest`: с `evidenceArtifactRef` → в artifactRefs; без — байт-в-байт старое.
3. Провайдер + селектор: none→null/available=false; fixture→валидный артефакт; **boot-guards (правки 1,2): `LAB_PAPER_EVIDENCE_REQUIRED=true`+source=none → boot-fail; source=fixture без NODE_ENV=test/LAB_ALLOW_FIXTURE_EVIDENCE → boot-fail**; http→заглушка помечена.
4. `paperStartHandler`: REQUIRED=false+available=false → submit без evidence (старое); REQUIRED=true+provide=null → evidence_required + НЕ submit; verify-fail → evidence_rejected + НЕ submit; happy → evidence в CAS + ref в artifactRefs + submit.
5. Интеграционный: champion → provide(fixture) → verify → CAS → submit с evidence-ref (fake transport фиксирует artifactRefs).

## 6. Acceptance (честно)
- **lab-side**: verify-матрица (unit) + fixture-happy интеграция — зелёные в CI. Tampered artifact → signature_invalid (реальный Ed25519, fake-ключ).
- **live full loop** (реальный WFO champion → VPS intake → `admitted`) — **зависит от Deliverable A** (бэктестер подписывает реальный ран + отдаёт fetchable) и http-провайдера (follow-up). В acceptance ЭТОГО слайса НЕ входит.

## 7. Рассмотренные альтернативы
- **Только handoff, lab ждёт**: мост остаётся quarantine-уязвим, консьюмер не готов к бэктестер-релизу; отклонено — консьюмер за швом дёшев и тестируем на fixture.
- **Lab-self-sign (временно)**: ломает trust-модель (лаб = свой судья); допустимо ТОЛЬКО если ключ — общий dev-ключ, не prod-trust. Отклонено как дефолт; fixture-source закрывает demo-нужду без prod-ключа.
- **Править paper-intake.port.ts широко (#127)**: минимизируем — только аддитивный опциональный `evidenceArtifactRef`.

## 8. Риски
- http-провайдер зависит от формы, которую бэктестер ещё не зафиксировал (evidence в result vs endpoint) — поэтому в слайсе заглушка + follow-up; порт-шов изолирует.
- Canonical-форма body для подписи ДОЛЖНА совпасть с бэктестерной (`canonicalizeEvidenceBody`) байт-в-байт, иначе verify расходится — тест использует fixture, подписанный ТЕМ ЖЕ vendored каноникайзером; риск рассинхрона с реальным бэктестером закрывается экспортом canonicalizer из SDK (Deliverable A §4) — до этого lab-verify реального evidence не гарантирован (fixture-happy ≠ live-happy — отражено в §6 acceptance).
- TRUSTED_SIGNERS в lab (для verify) — env `LAB_TRUSTED_SIGNERS_JSON` (keyId→pubkey), дефолт с известным backtester pubkey `bt-ed25519-cb1661aa4bcbfff8`.
