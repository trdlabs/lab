# Research notes: `long_oi` (Long OI)

> **Назначение.** Это вспомогательные research-заметки (подробный reverse-engineering стратегии
> `long_oi` из `trading-platform`), а **не** primary input для StrategyAnalyst. Primary input —
> вендоренный код модуля в `docs/fixtures/strategies/long-oi-code/`; эти заметки нужны для проверки/
> сверки того, что StrategyAnalyst извлечёт из кода, и как справочник по реальной логике.
>
> **Статус.** Research-only (read-only анализ). `trading-platform` не изменялся, production-код
> `trading-lab` не изменялся. Это не StrategyProfile и не результат запуска StrategyAnalyst.
>
> **Источник истины.** Описание восстановлено из кода модуля `026 Long OI StrategyModule`
> (`trading-platform/src/strategies/long_oi/**`) — чистого порта legacy-стратегии `dump_long`.
> Все числовые дефолты взяты из `params.ts::DEFAULT_PARAMS` и сверены с
> `src/bots/long_oi/config.ts::makeLongOiBotConfig()`. См. раздел **Evidence**.
>
> **Версия описанного модуля.** `id: 'long_oi'`, `version: '1.0.0'`, `contractVersion: '017.1'`,
> `status: 'research_only'`.

---

## 1. Краткое summary

`long_oi` — это **long-only** rule-based стратегия для крипто-перпетуалов на минутном таймфрейме.
Идея: после резкого падения цены (dump) дождаться разворота, **подтверждённого восстановлением
open interest и наличием long-ликвидаций**, и войти в лонг «на отскоке от капитуляции». Внутри
позиции — лестница тейк-профитов (TP1/TP2), перевод стопа в безубыток после TP1, DCA-усреднения на
дальнейших проливах, жёсткий стоп и выход по времени.

Логика — детерминированный конечный автомат (FSM) без технических индикаторов (`asOfIndicators: false`):
сигналы строятся только из OHLCV, open interest (OI) и ликвидаций.

---

## 2. Направление (direction)

- **Только long.** Решение о входе всегда `{ kind: 'enter', side: 'long' }`. Шорт-ветки нет.
- Стратегия рассчитана на **mean-reversion после капитуляционного пролива**, а не на трендследование.

---

## 3. Core idea (ядро гипотезы)

1. Найти на окне последних минут **резкий пролив** (dump) — цена упала и **держится внизу** (не успела
   восстановиться).
2. Перейти в режим наблюдения (watch) на ограниченное время.
3. Войти в лонг, когда одновременно: цена начала отскакивать от локального минимума, **OI восстанавливается**
   (умные деньги набирают позицию обратно), и присутствуют **long-ликвидации** (был вынос стопов лонгистов —
   признак локальной капитуляции).
4. Управлять позицией: частичный TP1 → безубыток → TP2/стоп/время, при дальнейшем проливе — усреднять (DCA).

Семантика «long_oi»: вход в **long**, триггерится динамикой **OI** (open interest) совместно с
ликвидациями. Это не «торговля по индикатору OI», а фильтр подтверждения разворота.

---

## 4. Используемые рыночные признаки (market features)

Объявлены в манифесте модуля (`manifest.ts::LONG_OI_MANIFEST.dataNeeds`):

| Признак | Поле манифеста | Что именно используется |
|---|---|---|
| Закрытые свечи 1m (OHLCV) | `closedCandlesUpToCurrent: true` | `open/high/low/close/ts` последних N свечей, строго до текущего бара включительно (point-in-time, без заглядывания вперёд) |
| Open Interest | `openInterest: true` | `oiTotalUsd` — суммарный OI в USD; окно `ctx.market.oiWindow(3)` (последние 3 минутных значения) и `ctx.market.oiAsOf()` |
| Liquidations | `liquidations: true` | `longUsd` — объём long-ликвидаций текущей минуты (`ctx.market.liqAsOf()`) |
| Технические индикаторы | `asOfIndicators: false` | **Не используются.** Стратегия чисто rule-based, без TA |

Производная метрика: `liqRatioPct = longUsd / oiTotalUsd * 100` (зеркалит `market_aggregator.ts`).

**Деградация данных (важно для профиля).** Если рыночная лента OHLCV-only (нет `ctx.market`) или есть
gap в OI/ликвидациях (значение `undefined`) — модуль **не входит** и не подставляет нули: вход требует
полного OI-окна и текущих ликвидаций. Carry-forward (перенос последнего значения) запрещён.

---

## 5. Жизненный цикл / FSM (watch lifecycle)

Фазы: `IDLE → WATCHING → IN_POSITION → COOLDOWN → IDLE`.

- **IDLE** — ждём dump-сигнал. На каждом закрытии бара проверяем окно последних свечей детектором dump.
- **WATCHING** — dump найден, наблюдаем за разворотом до таймаута. Каждый бар обновляем локальный
  минимум/максимум после сигнала и проверяем условия входа.
- **IN_POSITION** — позиция открыта; работает логика TP/SL/BE/DCA/fail-fast.
- **COOLDOWN** — пауза после таймаута watch или после закрытия позиции; новые сигналы игнорируются до
  истечения cooldown.

Переходы:
- IDLE → WATCHING: сработал dump-детект (если сигнал не отфильтрован warmup-правилом).
- WATCHING → IN_POSITION: прошло подтверждение входа (`evaluateEntry.ok`) → эмитится `enter`; хост
  открывает позицию по `open(t+1)`.
- WATCHING → COOLDOWN: истёк `watch.maxMinutes` без входа.
- IN_POSITION → COOLDOWN: позиция закрылась (реконсиляция: на следующем баре фаза была `IN_POSITION`,
  а `ctx.position == null`).
- COOLDOWN → IDLE: наступило `cooldownUntil`.

`watch.maxMinutes = 40` мин (таймаут наблюдения), `watch.cooldownMinutes = 20` мин (пауза).

---

## 6. Сигнал входа: dump-детект (entry trigger)

Детектор работает на окне последних `dump.lookbackMin = 20` закрытых свечей (включая текущий бар).
Два режима, выбирается `dump.triggerMode` (дефолт `high_to_low`):

### 6.1 `high_to_low` (по умолчанию)

1. Найти максимум `high` в окне; от его индекса вперёд найти минимум `low`.
2. `dumpPctHighLow` = падение от этого максимума к минимуму, должно быть **≥ `dump.minDropPct` = 10%**.
3. `dumpPctHighToClose` = падение от максимума к текущему `close`, должно быть
   **≥ `dump.highToLowMinCloseHoldPct` = 6%** — цена всё ещё внизу, **не отскочила** к максимуму
   (фильтр «удержания пролива»).
4. `closePosInRangePct` (где закрылась свеча-минимум внутри своего диапазона `high–low`) должно быть
   **≤ `dump.highToLowMaxClosePosInRangePct` = 55%** — свеча-минимум закрылась в нижней части своего
   диапазона (не сильный разворотный бар).
5. Если свеча-минимум зелёная (`close ≥ open`) **и** отскок от минимума к текущему close
   (`bounceFromLowPct`) **> `dump.highToLowMaxGreenRecoveryBouncePct` = 3.5%** → сигнал **отклоняется**
   (рынок уже слишком сильно отскочил, capitulation «отыграна»).

### 6.2 `open_to_close` (альтернативный режим)

- `dumpPctOpenClose` = падение от `open` первой свечи окна к `close` последней,
  должно быть **≥ `dump.minDropPct` = 10%**. Дополнительные фильтры п. 3–5 **не применяются**.

Сигнал переносит в watch: `signalPrice` (= last close), `triggerMode`, `triggerPct`, `highest/lowest`
(+ их ts), `bounceFromLowPct`, `dumpPctHighLow`, `dumpPctOpenClose`.

### 6.3 Warmup-фильтр сигнала (только live)

Если сигнал получен на «прогревочных» свечах (их ts раньше `firstLiveCandleTs`), он пропускается, когда:
- возраст сигнала `> warmup.maxSignalAgeMin = 5` мин → `warmup_signal_too_old`, или
- `bounceFromLowPct > warmup.maxBounceFromLowPct = 5%` → `warmup_signal_already_bounced`.

В бэктесте `firstLiveCandleTs` отсутствует → правило инертно.

---

## 7. Confirmation logic — подтверждение входа

На каждом баре фазы WATCHING (требуются OI-окно из 3 значений и текущие long-ликвидации; иначе
watch-tick без действия) вычисляется `evaluateEntry`:

- `bouncePct = pctChange(close, localLowAfterSignal)` — отскок от локального минимума, отслеженного с
  момента сигнала.
- `fastCandlePct = pctChange(close, prevClose)` — однобарный импульс.
- `fastEntry = fastCandlePct ≥ entry.fastBouncePct (2.5%)` — режим «быстрого входа».
- `greenCandles` — число зелёных переходов `close[i] > close[i-1]` за последние 3 свечи.
- `oiRecovery = fastEntry ? pctChange(oi[2], oi[1]) : pctChange(oi[2], oi[0])` — восстановление OI за
  **1 минуту** (fast) или за **2 минуты** (обычный режим).
- `liqRatioPct = longLiqUsd / oiNow * 100`.

Вход разрешается, когда **выполнены ВСЕ** условия (иначе — причина отказа):
1. `fastEntry` **или** `greenCandles ≥ entry.requireGreenPriceCandles (2)` — цена растёт
   (иначе `price_not_rising_2m`).
2. `oiRecovery ≥ oiFilter.entryMinOiRecoveryPct2m (0.05%)` — OI восстанавливается
   (иначе `oi_not_recovered`).
3. `bouncePct ≥ entry.minBouncePctFromLow (0.6%)` — есть отскок от минимума
   (иначе `bounce_too_small`).
4. Если `liqFilter.requireLiquidation = true` (дефолт):
   - `longLiqUsd > 0` (иначе `no_liquidations`);
   - `liqRatioPct ≥ liqFilter.minLongLiqOiRatioPct (0.02%)` (иначе `liq_ratio_too_small`).

При успехе эмитится `enter long`; хост открывает позицию по `open(t+1)`. Диагностический subset
входа (`fastEntry`, `oiRecovery`, `bouncePct`, `liqRatioPct`, `triggerPct`) фиксируется в state.

---

## 8. DCA / averaging logic (усреднение в позиции)

DCA работает внутри позиции через под-состояние `miniWatch` (отслеживает новый локальный минимум).

Условие арминга доливки:
- `dropFromLastEntryPct = (lastEntryPrice − localLowAfterSignal) / lastEntryPrice * 100`
  ≥ `dca.dropPcts[dcaCount]` (дефолт `[3, 3]` → **3% на каждую доливку** от цены последнего входа),
- и `dcaCount < dca.maxAdds (2)`.

Затем переподтверждение `evaluateDca` (требуется OI-окно + 3 свечи, иначе доливка пропускается, no-throw):
- `fastEntry = fastCandlePct ≥ dca.reconfirm.fastBouncePct (2.0%)`;
- `fastEntry` **или** `greenCandles ≥ dca.reconfirm.requireGreenCandles (2)` (иначе `price_not_rising_2m`);
- `oiRecovery ≥ dca.reconfirm.minOiRecoveryPct2m (0.005%)` (иначе `oi_not_recovered`);
- `bouncePct = pctChange(currentPrice, localLow) ≥ dca.reconfirm.minBouncePctFromNewLow (0.5%)`
  (иначе `bounce_too_small`).

При успехе: `dcaCount += 1`, обновляются `lastEntryPrice` и локальный минимум, эмитится
`{ kind: 'add_to_position', mode: 'dca', sizingHint }`, где `sizingHint = dca.sizeMultipliers[dcaCount-1]`
(дефолт `[1.2, 1.5]`). Множитель — **только подсказка размера**; фактический размер авторитетен у хоста.

Итог: максимум **2 усреднения**, каждое — при падении ещё на ~3% от последнего входа и при тех же
сигналах разворота (отскок + восстановление OI + рост цены), что и первичный вход (но без обязательного
liq-фильтра — он в DCA не проверяется).

---

## 9. TP / SL / BE / exit logic (управление позицией)

`onPositionBar` на каждом баре в позиции выбирает **ровно одно** действие (раннер берёт первое решение
хука) в порядке приоритета:

1. **Полные выходы (высший приоритет):**
   - TP2 / полный выход: `price ≥ entry * (1 + tpLadder.tp2Pct/100)`, `tp2Pct = 5%` → `exit tp2`.
   - Hard stop: `price ≤ entry * (1 − hardStopPct/100)`, `hardStopPct = 12%` → `exit hard_stop`.
   - Time exit: время в позиции `≥ maxHoldMin = 180` мин → `exit time_exit`.
2. **Отложенный перевод в безубыток (BE):** на баре **после** TP1 (если был взведён) эмитится
   `update_protection { stop: entryPrice }` — стоп переносится в безубыток (ровно цена входа, без учёта
   комиссий/проскальзывания). Перевод откладывается на следующий бар, потому что частичный TP1 и
   обновление защиты не могут быть в одном баре (раннер исполняет одно решение на бар).
3. **TP1:** при первом достижении `price ≥ entry * (1 + tpLadder.tp1Pct/100)`, `tp1Pct = 3.5%`.
   Поведение задаётся `tpLadder.tp1Action` (дефолт `partial_exit`):
   - `partial_exit` (дефолт): `exit tp1` на `tpLadder.tp1ExitPercent = 50%` позиции + взвести BE на след. бар
     (если `protection.moveProtectionToBEAfterTp1 = true`).
   - `milestone_only`: только аннотация `tp1_milestone` + взвод BE (поведение, эквивалентное legacy).
   - `full_exit`: полный `exit tp1`.
4. **DCA** (см. раздел 8).
5. **Fail-fast** (см. раздел 10; по умолчанию выключен).
6. Иначе — `idle`.

**Важно про BE:** модуль **не эмитирует** отдельный `be_stop`-выход. Перемещение защиты — это
исключительно `update_protection`. Фактическое срабатывание BE-стопа внутри бара исполняет хост/раннер
(он закрывает остаток позиции, если цена коснулась стопа).

Сводка профиля выходов (дефолт): TP1 = +3.5% (частичный 50%, далее BE), TP2 = +5% (полный),
hard stop = −12%, time exit = 180 мин, trailing-стоп **отсутствует** (`protection.trailing = 'off'`).

---

## 10. Fail-fast (защитный ранний выход, по умолчанию ВЫКЛЮЧЕН)

`failFast.enabled = false` по умолчанию → ветка инертна. Когда включён, действует **до TP1** и закрывает
позицию (`exit fail_fast`), если ранний after-entry «дрейф» указывает на неудачный вход:
- прошло `≥ failFast.minCandlesAfterEntry (2)` свечей после входа;
- макс. отскок от входа `< failFast.skipIfBounceFromEntryPct (1.25%)` (иначе пропуск);
- сумма зелёных тел за 2 свечи `< failFast.maxSumGreenBodies2Pct (0.75%)`;
- дрейф close за 3 свечи `< failFast.maxCloseDrift3Pct (−1.5%)` (либо композитное правило при
  `driftCompositeEnabled = true`: `compositeDriftSoftPct = −1.2%`, `compositeMinLossPctVsEntry = −2.3%`).

---

## 11. Position / risk / execution boundaries (границы)

- **Сторона:** только long. Один инструмент = одна позиция (плоский FSM не входит, пока есть позиция).
- **Размер позиции:** стратегия размер **не задаёт** — отдаёт только `sizingHint` для DCA
  (множители `1.2`, `1.5`). Базовый размер и плечо — параметры хоста/live-бота, не модуля
  (`baseOrderUsd = 100`, `leverage = 1` — дефолты live-config, диагностируются как `sizing_model_delta`).
- **Лимит доливок:** `dca.maxAdds = 2` (модуль), при этом хост может дополнительно ограничивать через
  `RiskProfile.dcaLimits.maxAdds`.
- **Hint-поля** (`stop` / `take` / `sizingHint`) в решениях — валидны, но их принятие/clamp/reject —
  ответственность `RiskProfile` хоста, а не стратегии.

---

## 12. Важные параметры и пороги (DEFAULT_PARAMS)

Все значения — дефолты модуля из `params.ts::DEFAULT_PARAMS` (порт env-fallback'ов
`makeLongOiBotConfig()`). Это «начальная унифицированная стратегия».

### Dump-детект
| Параметр | Дефолт | Смысл |
|---|---|---|
| `dump.lookbackMin` | 20 (мин) | окно поиска пролива |
| `dump.minDropPct` | 10 (%) | мин. падение для сигнала |
| `dump.triggerMode` | `high_to_low` | режим детекта |
| `dump.highToLowMinCloseHoldPct` | 6 (%) | мин. удержание пролива к close |
| `dump.highToLowMaxClosePosInRangePct` | 55 (%) | макс. позиция close в диапазоне свечи-минимума |
| `dump.highToLowMaxGreenRecoveryBouncePct` | 3.5 (%) | макс. отскок зелёной свечи-минимума |

### Watch / cooldown
| Параметр | Дефолт | Смысл |
|---|---|---|
| `watch.maxMinutes` | 40 (мин) | таймаут наблюдения |
| `watch.cooldownMinutes` | 20 (мин) | пауза после таймаута/выхода |

### Entry confirmation
| Параметр | Дефолт | Смысл |
|---|---|---|
| `entry.minBouncePctFromLow` | 0.6 (%) | мин. отскок от лоу |
| `entry.requireGreenPriceCandles` | 2 | требуемых зелёных свечей |
| `entry.fastBouncePct` | 2.5 (%) | порог быстрого входа |
| `oiFilter.entryMinOiRecoveryPct2m` | 0.05 (%) | мин. восстановление OI |
| `liqFilter.requireLiquidation` | true | требовать long-ликвидации |
| `liqFilter.minLongLiqOiRatioPct` | 0.02 (%) | мин. отношение long-liq к OI |
| `liqFilter.lookbackMin` | 8 (мин) | объявлено (см. uncertainties — модулем не используется) |
| `liqFilter.minLongLiqUsd` | 10 (USD) | объявлено (см. uncertainties — модулем не используется) |

### DCA
| Параметр | Дефолт | Смысл |
|---|---|---|
| `dca.maxAdds` | 2 | макс. доливок |
| `dca.dropPcts` | [3, 3] (%) | падение от последнего входа для арминга |
| `dca.reconfirm.minBouncePctFromNewLow` | 0.5 (%) | мин. отскок от нового лоу |
| `dca.reconfirm.minOiRecoveryPct2m` | 0.005 (%) | мин. восстановление OI |
| `dca.reconfirm.requireGreenCandles` | 2 | зелёных свечей |
| `dca.reconfirm.fastBouncePct` | 2.0 (%) | порог быстрого добора |
| `dca.sizeMultipliers` | [1.2, 1.5] | sizingHint доливок (только подсказка) |

### Exit / protection
| Параметр | Дефолт | Смысл |
|---|---|---|
| `tpLadder.tp1Pct` | 3.5 (%) | порог TP1 |
| `tpLadder.tp1Action` | `partial_exit` | поведение на TP1 |
| `tpLadder.tp1ExitPercent` | 50 (%) | доля частичного выхода на TP1 |
| `tpLadder.tp2Pct` | 5 (%) | порог TP2 (полный выход) |
| `hardStopPct` | 12 (%) | жёсткий стоп |
| `maxHoldMin` | 180 (мин) | выход по времени |
| `protection.moveProtectionToBEAfterTp1` | true | BE после TP1 |
| `protection.trailing` | `off` | trailing отсутствует |

### Fail-fast (выключен)
| Параметр | Дефолт | Смысл |
|---|---|---|
| `failFast.enabled` | false | по умолчанию выключен |
| `failFast.minCandlesAfterEntry` | 2 | свечей до оценки |
| `failFast.maxCloseDrift3Pct` | −1.5 (%) | макс. дрейф close за 3 свечи |
| `failFast.maxSumGreenBodies2Pct` | 0.75 (%) | макс. зелёные тела за 2 свечи |
| `failFast.skipIfBounceFromEntryPct` | 1.25 (%) | пропуск при отскоке от входа |

### Warmup
| Параметр | Дефолт | Смысл |
|---|---|---|
| `warmup.candlesMin` | 30 | мин. свечей до торговли (host-gating, см. uncertainties) |
| `warmup.maxSignalAgeMin` | 5 (мин) | макс. возраст warmup-сигнала |
| `warmup.maxBounceFromLowPct` | 5 (%) | макс. отскок warmup-сигнала |

---

## 13. Разделение ответственности (что решает кто)

### Что решает СТРАТЕГИЯ (модуль `long_oi`)
- Детект dump, арминг и таймаут watch, cooldown, FSM-переходы.
- Все условия входа/доливки/выхода и **абстрактные решения** из замкнутого union `StrategyDecision`:
  `enter` / `exit{target}` / `add_to_position` / `update_protection` / `annotate` / `idle`.
- Куда переносить защиту (BE = цена входа) — как намерение `update_protection`.
- `sizingHint` для DCA (подсказка, не обязательство).
- Чистая, детерминированная функция: без I/O, без wall-clock (только `ctx.bar.ts`/`ctx.clock`),
  без RNG вне `ctx.rng`, без сетевых вызовов.

### Что владеет RUNNER / PLATFORM (host)
- Предоставляет point-in-time `StrategyContext`: `bar`, `position` (`PositionSnapshot`:
  `side/size/entryPrice/stop/take`), `portfolio`, `data.closedCandles(n)`, `market.oiWindow/oiAsOf/liqAsOf`,
  `params`, детерминированные `clock`/`rng`.
- Исполняет **ровно одно** решение на бар (берёт `firstDecision` хука).
- Открывает позицию по `open(t+1)` после `enter`.
- Авторитетная экономика: фактический размер позиции (equity-fraction), плечо, комиссии, проскальзывание,
  фактические fills, средняя цена входа.
- Принятие/clamp/reject hint-полей через `RiskProfile`; лимиты DCA.
- **Физическое срабатывание BE-стопа внутри бара** (закрывает остаток при касании стопа) — модуль лишь
  двигает защиту через `update_protection`.
- Warmup-гейтинг (`warmup.candlesMin`), подстановка `firstLiveCandleTs`.
- Выбор пути стратегии: `LongOiStrategyPath = 'module' | 'legacy'` (дефолт `'module'`; legacy =
  `DumpLongStrategy` как переходный fallback).

### Что владеет EXCHANGE / EXECUTION layer
- Реальный сбор рыночных данных: свечи, суммарный OI (`oiTotalUsd`), потоки ликвидаций — агрегируются из
  бирж (OKX/Bybit/Bitget и др.) рыночным агрегатором; модуль потребляет только готовые point-in-time снимки.
- Фактическая маршрутизация ордеров и исполнение на бирже.
- Стратегия **не** обращается к бирже напрямую и **не** видит детали исполнения.

---

## 14. Известные неопределённости / что НЕ выводится из кода

1. **`liqFilter.lookbackMin (8)` и `liqFilter.minLongLiqUsd (10)` объявлены, но модулем не используются.**
   `evaluateEntry` проверяет только long-ликвидации **текущей минуты** (`liqLongNow`) на `> 0` и
   `liqRatioPct ≥ 0.02%`. Окно в 8 минут и порог $10 в ported-логике не применяются (вероятно, это
   legacy-поведение, упрощённое при порте). StrategyProfile не должен утверждать про 8-мин окно ликвидаций.
2. **TP1-поведение различается между legacy и модулем.** В модуле дефолт `partial_exit` 50% + BE; в legacy
   эквивалент `milestone_only` (только взвод BE). Какой режим в проде — зависит от пути (`module`/`legacy`)
   и переданных `params`.
3. **Размер позиции / equity-модель — host-owned.** `baseOrderUsd = 100`, `leverage = 1` — это дефолты
   live-config (`config.ts`), а не поведение стратегии; фактический сайзинг авторитетен на хосте.
   Множители DCA `1.2/1.5` — только `sizingHint`.
4. **Trailing-стоп не реализован** — тип `protection.trailing` существует, но единственное значение `'off'`.
5. **Режим `open_to_close`** существует, но дефолт — `high_to_low`; дополнительные фильтры high_to_low
   (удержание close, позиция в диапазоне, green-recovery) к `open_to_close` **не применяются**.
6. **Точное происхождение OI/liq-данных** (какие биржи, окно агрегации, как считается `liqRatioPct` в
   реальном времени) — на стороне market-aggregator/хоста; из кода стратегии не выводится.
7. **Специальные entry-варианты не портированы в модуль:** `postSpikeCascade` и
   `extremeReboundThinSupport` (точечные guard'ы по символам, в live-config по умолчанию выключены),
   `riskScoreScaler` (масштабирование размера по risk-score), `failFast.entryGate.*` (suppress-подграф).
   Они существуют в live-config `makeLongOiBotConfig()`, но **исключены** из модуля как host-owned/default-off.
   Их в профиль базовой стратегии включать не следует.
8. **`fastEntry` меняет окно восстановления OI** с 2 минут на 1 минуту — это влияет на чувствительность
   фильтра OI и взаимодействует с порогом `entry.fastBouncePct`.
9. **`warmup.candlesMin (30)`** — минимум свечей до начала торговли; это host-гейтинг прогрева, в показанной
   flat-логике напрямую не используется (используются только `maxSignalAgeMin`/`maxBounceFromLowPct`/
   `firstLiveCandleTs`).

---

## 15. Evidence (источники в `trading-platform` и что из них выведено)

Все пути — относительно корня репозитория `trading-platform`.

**Ядро стратегии (модуль `026 Long OI StrategyModule`):**
- `src/strategies/long_oi/manifest.ts` — id/version/status/`dataNeeds`(closed/oi/liq, `asOfIndicators:false`)/
  хуки `onBarClose`+`onPositionBar`; summary и rationale стратегии.
- `src/strategies/long_oi/params.ts` — `LongOiParams`, `DEFAULT_PARAMS` (все числовые дефолты раздела 12),
  JSON Schema параметров; комментарии о host-owned параметрах, не воспроизводимых модулем.
- `src/strategies/long_oi/signals.ts` — чистые помощники: `detectDump`/`detectHighToLow`/`detectOpenToClose`
  (логика dump, раздел 6), `evaluateEntry` (подтверждение входа, раздел 7), `evaluateDca` (раздел 8),
  `shouldTakeTp`/`shouldHardStop` (раздел 9), `evaluateFailFast` (раздел 10), `oiWindow3`/`liqLongNow`/
  `liqRatioPctOf` (market features, раздел 4).
- `src/strategies/long_oi/flat_phase.ts` — flat-фаза `onBarClose`: FSM IDLE/WATCHING/COOLDOWN, `armWatch`,
  `enterCooldown`, `warmupSkipReason` (раздел 5, 6.3, 7).
- `src/strategies/long_oi/position_phase.ts` — in-position `onPositionBar`: приоритет выходов, TP1/TP2/BE/
  hard_stop/time_exit, DCA mini-watch, fail-fast (разделы 8–10).
- `src/strategies/long_oi/state.ts` — `LongOiPhase`, `LongOiWatchSignal`, `LongOiModuleState`, mini-watch,
  recompute-хелперы (форма сигнала и состояния, раздел 5).
- `src/strategies/long_oi/module.ts` — сборка `{ manifest, init, onBarClose, onPositionBar }`, per-symbol
  изоляция состояния.

**Контракты (граница strategy ↔ host):**
- `src/contracts/research/decision.ts` — `StrategyDecision` union (`enter`/`exit`/`add_to_position`/
  `update_protection`/`annotate`/`idle`); hint-поля валидны, accept/clamp — за RiskProfile (раздел 13).
- `src/contracts/research/context.ts` — `StrategyContext`/`PositionSnapshot`/`PointInTimeDataApi`;
  point-in-time, no-lookahead инвариант; опциональная рыночная поверхность `market?` (раздел 4, 13).
- `src/contracts/research/market-tape.ts` — типы рыночной поверхности (`OiPoint`/`LiqPoint`, `oiWindow`/
  `oiAsOf`/`liqAsOf`) — провенанс полей OI/ликвидаций.

**Live-bot обвязка (что выбирает путь и даёт env-дефолты):**
- `src/bots/long_oi/config.ts::makeLongOiBotConfig()` — env-конфиг live-бота: те же числовые дефолты + поля
  host-owned (`risk`, `riskScoreScaler`, `postSpikeCascade`, `extremeReboundThinSupport`,
  `failFast.entryGate`) — источник пунктов uncertainties 3, 7.
- `src/bots/long_oi/create_bot.ts` — `LongOiStrategyPath = 'module' | 'legacy'` (дефолт `module`);
  `createLongOiBot` подключает модуль через `ModuleStrategyAdapter`, fallback — `DumpLongStrategy` (раздел 13).
- `src/app/run_long_oi.ts` — процессный entrypoint live-бота (`bot:start:long`).
- `src/strategies/dump_long/strategy.ts` — legacy-стратегия `DumpLongStrategy`, поведенческая карта которой
  портирована в модуль (legacy fallback).

**Спецификации (вторичные, для сверки намерений):**
- `specs/026-long-oi-strategy-module/spec.md`, `.../data-model.md`,
  `.../contracts/{params-schema,module-interface,decision-mapping,forbidden-boundary,rollout,live-adapter}.md`
  — формализация параметров, FSM, маппинга решений и rollout-флага.
- `specs/025-long-oi-golden-master/spec.md` — эталонное (golden-master) поведение legacy `dump_long`.
- `research/026-long-oi-strategy-module-refactor-research.md` — обоснование рефакторинга в единый модуль.

---

## 16. Подсказка для StrategyAnalyst (как читать этот документ)

- Базовый профиль строить **только по разделам 4–13** (поведение модуля) с числами из раздела 12.
- Не включать в профиль host-owned / default-off элементы из uncertainties (п. 1, 3, 7).
- При неоднозначности предпочитать формулировки из uncertainties, а не доопределять пороги «от себя».
- Направление: long-only; класс стратегии: rule-based mean-reversion на капитуляционном проливе с
  OI/liq-подтверждением, лестницей TP, BE и DCA.
