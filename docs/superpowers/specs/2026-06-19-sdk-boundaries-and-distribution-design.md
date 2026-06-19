# Границы и поставка SDK экосистемы trading

**Статус:** согласованный дизайн  
**Дата:** 2026-06-19  
**Область:** `trading-platform`, `trading-backtester`, `trading-lab`,
`trading-mock-platform`

## 1. Проблема

`trading-lab` сейчас получает закрытый `@trading-platform/sdk` как закоммиченный
tarball:

```text
vendor/trading-platform-sdk/trading-platform-sdk-0.3.0.tgz
```

Это сделало clone `trading-lab` независимым от sibling checkout
`../trading-platform`, но создало другой набор проблем:

- бинарный артефакт закрытого репозитория фактически распространяется через
  публичный `trading-lab`;
- обновление версии и integrity lockfile выполняются вручную;
- история Git накапливает все версии tarball;
- у пакета нет отдельного публичного lifecycle, changelog и явной лицензии;
- package boundary устарел после выделения `trading-backtester`: platform SDK
  по-прежнему содержит builder и backtest workflow;
- `@trading-backtester/client` подключен через
  `file:../trading-backtester/packages/client`, поэтому весь `trading-lab` пока
  всё равно не устанавливается из чистого clone без sibling checkout.

Цель изменений -- получить два независимо версионируемых SDK по bounded
context, не публикуя их в npmjs и не требуя от пользователя локальных sibling
репозиториев или package-registry credentials.

## 2. Принципы владения

1. SDK принадлежит системе, API которой он представляет.
2. Mock реализует контракт, но никогда не владеет production-контрактом.
3. `trading-lab` оркестрирует системы и не становится источником истины для их
   wire DTO.
4. Публичный SDK не содержит implementation платформы, credentials, live-order
   execution или внутренних storage-моделей.
5. Внешний пакет содержит только стабильную consumer surface. Внутренние типы
   не публикуются ради удобства импорта.
6. LLM/research domain (`StrategyProfile`, `Hypothesis`, `Evaluation`) остаётся
   в `trading-lab`. Исполняемый module/bundle contract принадлежит backtester.

## 3. Целевая карта пакетов

```text
public trading-platform-sdk repository
└── @trading-platform/sdk
    ├── platform data/catalog API
    ├── historical-data DTO and client
    ├── ops-read DTO (paper/live bot observations)
    ├── paper-candidate intake
    ├── platform capabilities/versioning
    └── HTTP/MCP transports for platform APIs

public trading-backtester repository
└── packages/sdk -> @trading-backtester/sdk
    ├── /builder
    ├── /client
    ├── /contracts
    └── /artifacts

public trading-lab repository
├── consumes @trading-platform/sdk
└── consumes @trading-backtester/sdk

public trading-mock-platform repository
└── implements @trading-platform/sdk contracts
```

Новый отдельный репозиторий нужен для platform SDK, потому что исходный
`trading-platform` закрыт. Для backtester SDK отдельный репозиторий не нужен:
`trading-backtester` уже публичен и является правильным владельцем пакета.

## 4. Состав `@trading-platform/sdk`

### Остаётся в platform SDK

- capability discovery платформы;
- каталог и получение historical datasets;
- типы platform-owned historical data contract;
- read-only сведения о ботах, paper/live run observations и операционном
  состоянии (`ops-read`);
- intake кандидата на paper-проверку после исследования;
- platform-specific HTTP/MCP transports;
- версии и compatibility metadata этих контрактов.

`intake` остаётся platform-owned: это admission boundary платформы. Ссылки на
backtest runs и artifacts в evidence передаются как opaque identifiers и не
делают platform SDK владельцем backtest contract.

### Удаляется из platform SDK

- `@trading-platform/sdk/builder`;
- создание `StrategyModule` / `HypothesisOverlayModule` bundle;
- локальный backtest preflight;
- `validateModule`, `submitRun`, `getRunStatus`, `getRunResult`, cancel и
  backtest artifact pagination;
- DTO lifecycle backtest job.

Эти поверхности появились, когда backtest gateway находился внутри платформы.
После extraction в `trading-backtester` они являются legacy compatibility
surface и должны мигрировать к новому владельцу.

## 5. Состав `@trading-backtester/sdk`

### `/builder`

- manifest constructors для strategy/overlay module;
- data-needs/capabilities helpers;
- deterministic bundle assembly и hashing;
- lightweight local preflight;
- безопасные templates и authoring types.

Preflight не исполняет пользовательский код и не заменяет authoritative
validation в sandbox backtester.

### `/client`

- typed HTTP client;
- capabilities/datasets reads;
- validate and submit;
- status, result, cancel и bounded polling;
- artifact manifest/page reads;
- typed error taxonomy.

### `/contracts`

- executable module and bundle contract;
- backtest request/job lifecycle;
- validation report;
- metrics/comparison/evidence DTO;
- version constants and compatibility helpers.

### `/artifacts`

- artifact descriptors, references and pagination DTO;
- content-hash vocabulary;
- никакого прямого filesystem/blob-store доступа.

На первой миграции используется один пакет с subpath exports и общей semver
версией. Это гарантирует совместимость builder, contracts и client и проще,
чем синхронно выпускать несколько мелких пакетов.

Текущий `@trading-backtester/client` временно сохраняется как deprecated
compatibility package или wrapper на один migration window. Новые потребители
используют `@trading-backtester/sdk/client`.

## 6. Взаимодействие bounded contexts

```text
trading-lab
  |
  | platform SDK: data, bot observations, paper admission
  +------------------------------------------------------> trading-platform
  |                                                        or mock-platform
  |
  | backtester SDK: build, validate, submit, result
  +------------------------------------------------------> trading-backtester
```

Допустима односторонняя зависимость backtester от platform historical-data
contract, потому что платформа является provider данных. Platform intake не
зависит от backtester SDK: он принимает evidence snapshot и opaque references.
Это предотвращает циклическую package dependency.

## 7. Канал поставки без npmjs

### Выбранный вариант: GitHub Releases

CI исходного публичного репозитория:

1. проверяет тесты, typecheck и API compatibility;
2. собирает package `dist`;
3. запускает `npm pack` и проверяет allowlist содержимого;
4. генерирует SHA-256 checksum и manifest с source commit;
5. создаёт immutable-by-policy Git tag/release;
6. прикрепляет `.tgz`, checksum и manifest как release assets.

Потребитель закрепляет точный release URL:

```json
{
  "dependencies": {
    "@trading-platform/sdk": "https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/v0.4.0/trading-platform-sdk-0.4.0.tgz",
    "@trading-backtester/sdk": "https://github.com/alexnikolskiy/trading-backtester/releases/download/sdk-v0.2.0/trading-backtester-sdk-0.2.0.tgz"
  }
}
```

Имя пакета внутри tarball может остаться `@trading-platform/sdk`: занятость
scope в npmjs не имеет значения, потому что npm registry не используется.
`pnpm-lock.yaml` фиксирует разрешённый URL и integrity.

Release assets запрещено заменять после публикации. Исправление выпускается
новой semver-версией. Release workflow проверяет, что tag и asset ещё не
существуют.

### Почему не GitHub Packages

GitHub npm registry требует:

- scoped name в namespace владельца, например
  `@alexnikolskiy/trading-platform-sdk`;
- committed `.npmrc` с registry mapping;
- classic PAT для publish и, согласно актуальной документации GitHub, для
  install публичных npm packages.

Это ухудшает clean-clone и demo UX, поэтому GitHub Packages не используется.

### Почему не Git dependency

Зависимость вида `github:user/repo#tag` привязывает установку к layout исходного
репозитория и lifecycle scripts (`prepare`). Release tarball является уже
проверенным consumer artifact и лучше отделяет source от distribution.

## 8. Версионирование и совместимость

- platform SDK и backtester SDK имеют независимый semver;
- breaking wire/API change требует major version;
- additive DTO fields требуют backward-compatible parsing;
- каждый SDK публикует contract/version constants;
- каждый сервис CI-тестом проверяет свою реализацию против текущего SDK;
- `trading-lab` и `trading-mock-platform` имеют clean-install smoke tests по
  release URL без sibling checkout;
- dependency update выполняется отдельным PR с typecheck, tests и cross-repo
  contract tests.

До первого публичного релиза каждый SDK обязан получить явно выбранный
`LICENSE`. Без лицензии release workflow блокируется. Выбор конкретной лицензии
является решением владельца репозиториев, а не технической миграцией.

## 9. План миграции

### Этап 1. Platform SDK repository

- создать публичный `trading-platform-sdk`;
- перенести только разрешённую platform consumer surface;
- удалить builder/backtest workflow из новой public surface;
- добавить package allowlist, API compatibility и release workflow;
- выпустить первую GitHub Release версию.

На время перехода private `trading-platform` проверяет conformance своей
реализации с опубликованным SDK.

### Этап 2. Backtester SDK

- в публичном `trading-backtester` создать/переименовать `packages/sdk`;
- перенести platform builder snapshot/helpers;
- объединить их с текущим `@trading-backtester/client` и wire contracts через
  subpath exports;
- сделать backtester source of truth для module validation/run/artifacts;
- выпустить GitHub Release asset;
- оставить ограниченное compatibility окно для старого client package.

### Этап 3. Consumers

- перевести `trading-lab` на два release URL;
- перевести `trading-mock-platform` на platform SDK release;
- удалить sibling `file:` dependency на backtester client;
- добавить clean-clone install gates в CI;
- проверить research-only invariant и отсутствие live execution authority в
  SDK и `trading-lab`.

### Этап 4. Удаление legacy

- удалить platform builder и backtest agent exports после миграционного окна;
- удалить vendored SDK tarball и его guard tests из `trading-lab`;
- обновить README, diagrams и AGENTS navigation;
- запретить новые `file:../...` production dependencies CI-проверкой.

## 10. Git и очистка публичных артефактов

До завершения миграции существующие specs, plans, roadmaps и tarball остаются в
Git как страховочная копия и исторический контекст.

После перехода выполняется отдельный audit:

- какие документы полезны как публичная инженерная история;
- какие содержат private implementation details, source SHAs или устаревшие
  инструкции;
- какие generated/eval artifacts должны быть ignored;
- нужно ли удалить tarball только из HEAD или также переписать Git history.

Обычный `git rm` не удаляет уже опубликованный tarball или документ из истории.
Если потребуется фактическое удаление, это отдельная coordinated operation через
`git filter-repo` с force-push, уведомлением потребителей и пересозданием clones.
Она не совмещается с функциональной SDK-миграцией.

## 11. Не входит в эту инициативу

- публикация в npmjs;
- private package registry;
- перенос SDK в `trading-mock-platform`;
- единый универсальный пакет всех trading-доменов;
- изменение live execution платформы;
- изменение research workflow или LLM-агентов;
- немедленное переписывание публичной Git history.

## 12. Критерии готовности

1. Чистый clone `trading-lab` устанавливается без sibling репозиториев и tokens.
2. В `trading-lab` нет vendored SDK tarballs и production `file:../...`
   dependencies.
3. Platform SDK не экспортирует builder/backtest lifecycle.
4. Backtester SDK владеет builder, module/run validation, client и artifacts.
5. Real и mock platform проходят один conformance suite.
6. Release assets воспроизводимы, версионированы и имеют checksum/source
   manifest.
7. SDK не предоставляет live-order execution authority.

