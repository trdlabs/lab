# AGENTS.md — trading-lab

> Гид для AI-агентов (Codex, Claude Code и др.). Поведенческие правила см. в `CLAUDE.md`.
> Этот файл — быстрый контекст + команды, чтобы агент не тратил токены на разбор репо.

## Что это
**AI-агент для исследования торговых стратегий** — «исследовательский мозг» над
торговой платформой. Онбордит стратегию, выдвигает и проверяет гипотезы об её
улучшении, генерирует код-варианты, прогоняет бэктесты в песочнице платформы и
выносит решение по каждому варианту (отдавать ли на paper-проверку).

⚠️ **Research-only. Агент ничего не торгует вживую** — execution-адаптера нет физически.
Сгенерированный код исполняет только изолированная песочница платформы, не сам trading-lab.

Это дипломный проект курса по инженерии AI-агентов.

## Стек
- **TypeScript** (ESM, `node --experimental-strip-types` — запуск .ts напрямую)
- **Mastra** (`@mastra/core`) — фреймворк агентов (аналог LangGraph для Node)
- **BullMQ** — очередь/оркестрация; **Postgres** + **Drizzle ORM** — хранение
- LLM-провайдеры: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider`
- **Zod** — схемы; **Hono** — HTTP; **MCP SDK**
- Внешние пакеты экосистемы: `@trading-platform/sdk`, `@trading-backtester/client`
- **Vitest** — тесты (115 файлов, детерминированные ассерты + проверка tool-вызовов)
- Docker: `docker-compose.{local,demo,vps}.yml`

## Архитектура (5 агентов, гексагональная)
- `src/mastra/` — конфигурация агентов Mastra
- `src/domain/` — доменные сущности (гипотезы, fingerprint, стратегии)
- `src/ports/` — порты (≥5 портов, ≥2 внешних)
- `src/adapters/` — реализации портов: `llm`, `queue`, `repository`, `researcher`,
  `builder`, `analyst`, `critic`, `platform`, `artifact`, `intent`, `similarity`, `read`
- `src/orchestrator/` — нелинейная оркестрация (7 точек ветвления), `handlers/`
- `src/worker/`, `src/ingress/` — воркер очереди и входной HTTP-сервер
- `src/validation/`, `src/read-api/`, `src/chat/`, `src/db/`, `src/config/`, `src/auth/`

## Команды
```bash
pnpm install
pnpm typecheck            # tsc -p tsconfig.json
pnpm test                # vitest run
pnpm test:watch

# Запуск компонентов:
pnpm ingress             # входной HTTP-сервер
pnpm worker              # воркер очереди
pnpm platform:discover   # обнаружение платформы
pnpm platform:validate   # валидация
pnpm platform:run        # прогон цикла
pnpm platform:resume     # возобновление

pnpm analyst:eval        # оффлайн-оценка strategy-analyst (читает .env)

# БД (Drizzle):
pnpm db:generate         # генерация миграций
pnpm db:migrate          # применение
```

## Правила для агента
- Соблюдай инвариант **research-only**: не добавляй ничего, что исполняет ордера.
- Доступ к платформе — только через `@trading-platform/sdk` (read/sandbox), к бэктестеру — через `@trading-backtester/client`.
- Новые порты/адаптеры — по гексагональному паттерну, тесты в `test/` обязательны.
- LLM-вызовы детерминируй где можно; в тестах проверяй факт и аргументы tool-вызовов.
- README и уточняющие вопросы — на русском.

## Навигация по коду
Предпочитай **codegraph/Gortex MCP** для поиска символов и связей вместо ручного grep+read.

<!-- gortex:communities:start -->
<!-- gortex:skills:start -->
## Community Skills

| Area | Description | Skill |
|------|-------------|-------|
| Adapters Repository 3 Dirs Hypothesisbuildhandler | 165 symbols | `/gortex-adapters-repository-3-dirs-hypothesisbuildhandler` |
| Adapters Platform 1 Dirs Runbacktestprobe | 82 symbols | `/gortex-adapters-platform-1-dirs-runbacktestprobe` |
| Chat 2 Dirs | 71 symbols | `/gortex-chat-2-dirs` |
| Experiments Intent Classifier Runonce | 59 symbols | `/gortex-experiments-intent-classifier-runonce` |
| Adapters Repository 1 Dirs Todomain | 53 symbols | `/gortex-adapters-repository-1-dirs-todomain` |
| Adapters Read 3 Dirs | 49 symbols | `/gortex-adapters-read-3-dirs` |
| Experiments Intent Classifier Renderreport | 46 symbols | `/gortex-experiments-intent-classifier-renderreport` |
| Scripts Main Intent Classifier Eval | 44 symbols | `/gortex-scripts-main-intent-classifier-eval` |
| Chat Handlechatmessage | 41 symbols | `/gortex-chat-handlechatmessage` |
| Adapters Platform 4 Dirs | 39 symbols | `/gortex-adapters-platform-4-dirs` |
| Experiments Strategy Analyst Runonce | 39 symbols | `/gortex-experiments-strategy-analyst-runonce` |
| Adapters Platform 2 Dirs Fixtureplatformgatewayadapter | 38 symbols | `/gortex-adapters-platform-2-dirs-fixtureplatformgatewayadapter` |
| Adapters Read 7 Dirs | 38 symbols | `/gortex-adapters-read-7-dirs` |
| Read Api 4 Dirs | 35 symbols | `/gortex-read-api-4-dirs` |
| Migrations Backtest Run | 33 symbols | `/gortex-migrations-backtest-run` |
| Ports 2 Dirs | 33 symbols | `/gortex-ports-2-dirs` |
| Orchestrator Handlers 6 Dirs Researchtask | 32 symbols | `/gortex-orchestrator-handlers-6-dirs-researchtask` |
| Experiments Strategy Analyst Scoreprofile | 31 symbols | `/gortex-experiments-strategy-analyst-scoreprofile` |
| Adapters Platform 2 Dirs Getrunresult | 29 symbols | `/gortex-adapters-platform-2-dirs-getrunresult` |
| Read Api Apply | 29 symbols | `/gortex-read-api-apply` |
<!-- gortex:skills:end -->

<!-- gortex:communities:end -->
