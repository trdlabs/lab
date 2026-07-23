# env-catalog (item 4) — типизированная env-схема lab

Дата: 2026-07-24. Контракт: `env-schema.1` (control-center,
`docs/architecture/contracts/env-schema.md` + `scripts/src/contracts/env-schema-1.schema.json`).
Инициатива: env-catalog (control-center, item 4 — per-repo схема lab).

## Сделано (этот срез)

- **Метаданные схемы** — `src/config/env-schema.ts`, рядом с `loadEnv`
  (`src/config/env.ts`), единый источник: тип, дефолт, secret/flag,
  owner_unit (`lab-u6`), consumers для каждой переменной. Рабочий hand-rolled
  `loadEnv` (fail-closed парсеры) сознательно **не** переписан на zod:
  контракт допускает существующий паттерн репо, парсинг и fail-fast не тронуты.
- **Экспорт** — `pnpm env:schema` печатает детерминированный документ
  `env-schema.1` в stdout (JSON, 2 пробела, `variables` отсортированы,
  завершающий `\n`). `env-schema.json` не коммитится (второй источник правды).
- **ENV.md** — генерируется из схемы: `pnpm env:docs`; дрейф пинуется тестом
  (`src/config/env-schema.test.ts` сравнивает файл с рендером байт-в-байт).
- **Advisory-скан** — `pnpm env:reads` (`scripts/env-reads-advisory.ts`):
  чтения `process.env` в `src/` вне allowlist — ошибка (пинуется
  `test/env-reads-advisory.test.ts`); имена из `scripts/` вне схемы —
  предупреждение (с `--strict` — ошибка).
- **Тесты** — локальная копия семантических правил контракта (12 правил),
  негативы валидатора, полнота относительно `loadEnv`, совпадение дефолтов
  схемы с фактическим поведением `loadEnv({})`, сохранение fail-fast
  (включая отклонение `LAB_BREAK_BATTERY_MODE=enforce` до item 7
  research-validation-hardening).

## Решения

- `LAB_BREAK_BATTERY_MODE` — единственный E4b-флаг схемы:
  `flag_states: [off, log]`, `default_state: off`; `enforce` намеренно
  отклоняется резолвером до пиновки порогов владельцем (item 7).
- `LAB_U6_IMAGE` объявлена как деплой-переменная compose (owner U6,
  consumers: `docker-compose.vps.yml`, `infra/scripts/unit-deploy.sh`),
  кодом не читается; `required: false`, т.к. обязательность ограничена
  VPS-деплоем (обязательная интерполяция `${LAB_U6_IMAGE:?}`).
- `DATABASE_URL`/`REDIS_URL` помечены secret (connection string несёт креды).
- `BACKTEST_BACKEND` и `OPERATOR_EMBEDDING_PROVIDER` в каталог не входят:
  ключи `Env` зашиты константой и из `process.env` не читаются.
- `TRADING_PLATFORM_READ_URL`/`TRADING_PLATFORM_READ_TOKEN`,
  `OFFICE_*`, `MOCK_*`, `BACKTESTER_AUTH_TOKEN` и пр. в compose-файлах —
  переменные соседних сервисов (office/mock-platform/backtester) в dev/demo
  стеке; их объявляют их собственные репо.

## Хвост (следующие срезы)

1. **Прямые чтения в `src/` (в allowlist, объявлены в схеме, миграция на
   `loadEnv` желательна):**
   - `src/orchestrator/handlers/research-run-cycle.handler.ts` —
     `TRADE_CONTEXT_WARMUP_MIN`, `TRADE_CONTEXT_TAIL_MIN`,
     `TRADE_CONTEXT_WINNERS_MAX`, `MARKET_HISTORY_LOOKBACK_DAYS`,
     `RESEARCHER_MAX_PER_PASS`;
   - `src/adapters/platform/select-run-trades.ts`,
     `select-research-platform.ts` — `BACKTESTER_API_URL`/`BACKTESTER_API_TOKEN`
     (дублируют значения из `loadEnv`, читают сами ради boot-safety);
   - `src/experiments/turn-interpreter/report.ts` — `MODEL_PROVIDER` +
     динамическая проверка наличия ключа.
2. **CLI-скрипты `scripts/`** читают env напрямую (BASELINE_*, LONGOI_CODE_DIR,
   PLATFORM_REPO_PATH, STRATEGY_BUILDER_*, STRATEGY_PROFILE_ID,
   ENTRY_SIGNAL_EVIDENCE, SRC/OUT_DIR и др.) — осознанно вне каталога
   (инструменты разработчика, не деплой-поверхность); список отдаёт
   `pnpm env:reads`.
3. **Item 7 (контракт):** генерация `.env*.example` из схемы, удаление ручных
   списков переменных, CI-джоб «Генерация» (перегенерировать + `git diff`);
   решение по `enforce` для break battery после пиновки порогов.
4. CI-гейт «Полнота схемы»: перевести `pnpm env:reads --strict` из advisory в
   обязательный после каталогизации/зачистки хвоста скриптов.
