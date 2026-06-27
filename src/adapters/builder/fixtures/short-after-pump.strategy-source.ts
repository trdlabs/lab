export const SHORT_AFTER_PUMP_SOURCE: string = `// Предсобранный ESM payload untrusted strategy-bundle (логика 018 \`short_after_pump\`).
//
// САМОДОСТАТОЧЕН ВНУТРИ module/ (FR-003): никаких импортов из репозиторного src/ или dist/, host-fs,
// npm-registry или внешних пакетов. Работает ТОЛЬКО с read-only 017 \`StrategyContext\`, который harness
// (US2) регидрирует из сериализованного snapshot'а. 017/018 TS type-импорты при «сборке» стёрты.
//
// Контракт инстанцирования (совпадает с harness T025, US2): entry default-экспортирует фабрику,
// возвращающую объект-модуль с lifecycle-хуками (по manifest.hooks). Здесь — только onBarClose.
//
// ПОБАЙТОВЫЙ ДВОЙНИК trusted \`shortAfterPump.onBarClose\` (engine examples/short-after-pump.strategy.ts):
// та же rationale-форма с платформенными ctx.indicators (RSI/MACD/ATR/Bollinger) — тот же engine
// code path (_engine) ⇒ те же значения ⇒ тот же decision ⇒ тот же result_hash (golden 0be9931c).

export default function createStrategyModule() {
  return {
    onBarClose(ctx) {
      const windowMin = Number(ctx.params.windowMin ?? 20);
      const pumpPct = Number(ctx.params.pumpPct ?? 10);
      const minVolume = Number(ctx.params.minVolume ?? 0);

      // Платформенные индикаторы через стабильный ctx.indicators (warmup → undefined).
      const rsi = ctx.indicators.query({ name: 'rsi', params: { period: 14 } });
      const macd = ctx.indicators.query({ name: 'macd' });
      const atr = ctx.indicators.query({ name: 'atr', params: { period: 14 } });
      const bollinger = ctx.indicators.query({ name: 'bollinger', params: { period: 20, stddev: 2 } });

      const history = ctx.data.closedCandles(windowMin);
      if (history.length < windowMin) return { kind: 'idle' };

      const past = history[0];
      const changePct = ((ctx.bar.close - past.close) / past.close) * 100;
      if (changePct >= pumpPct && ctx.bar.volume >= minVolume) {
        const parts = [\`pump \${changePct.toFixed(1)}% >= \${pumpPct}% при объёме \${ctx.bar.volume}\`];
        if (typeof rsi === 'number') parts.push(\`RSI=\${rsi.toFixed(1)}\`);
        if (typeof macd === 'object' && macd !== null && 'histogram' in macd) {
          parts.push(\`MACD.hist=\${macd.histogram.toFixed(4)}\`);
        }
        if (typeof atr === 'number') parts.push(\`ATR=\${atr.toFixed(4)}\`);
        if (typeof bollinger === 'object' && bollinger !== null && 'upper' in bollinger) {
          parts.push(\`BB.upper=\${bollinger.upper.toFixed(2)}\`);
        }
        return { kind: 'enter', side: 'short', rationale: parts.join('; ') };
      }
      return { kind: 'idle' };
    },
  };
}
`;
