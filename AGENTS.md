# AGENTS.md — trading-lab

This repository is part of the `trdlabs` trading ecosystem.

**Before planning or coding, read `../control-center/` when the task involves:**
- other repositories, system architecture, or integration boundaries
- API, MCP, SDK, or contract changes
- rollout, migration, or cross-repo validation
- local development, Docker, running the full ecosystem stack, or mock-platform data intervals
- fetching a new VPS snapshot and making it the ecosystem default fixture

**Read order when triggered:**
1. `../control-center/repos.yaml`
2. `../control-center/AGENTS.md`
3. `../control-center/repos/trading-lab.md`
4. `../control-center/docs/operations/local-development.md` when starting or debugging the local stack
5. `../control-center/docs/operations/mock-platform-data.md` when historical intervals (1m/1h/1d) or mock fixtures matter
6. `../control-center/docs/operations/mock-platform-snapshot-rollout.md` when ingesting a VPS slice or changing the default fixture across repos
7. `../control-center/ecosystem-defaults.yaml` and skill `mock-snapshot-default-rollout` when making a VPS slice the ecosystem default

If `../control-center` is absent (standalone clone), use local repo docs only.

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

<!-- Перенесено из CLAUDE.md 2026-08-20 при сведении инструкций в один файл.
     Держать ВНЕ маркеров gortex:*, иначе `gortex init` затрёт. -->
