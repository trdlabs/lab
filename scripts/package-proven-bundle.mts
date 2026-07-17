// Упаковка proven-source long_oi в КОНФОРМНЫЙ ModuleBundle через SDK scaffoldStrategyBundle
// (createModuleManifest инжектит contractVersion '017.2' + bundleContractVersion '019.1' и опускает
// незаданные params/source/targetStrategyRef/interceptionPoint — никогда не null). Решает manifest-дрейф
// ручной сборки (backtester acceptance-gate отклонял голый .mjs). Re-run билдера НЕ нужен: source
// уже byte-proven, упаковка ортогональна поведению. preflightValidateBundle подтверждает конформность.
//
// Запуск: SRC=<path-to-proven.mjs> OUT_DIR=<dir> npx tsx scripts/package-proven-bundle.mts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldStrategyBundle } from '@trdlabs/backtester-sdk/builder';

const SRC = process.env['SRC'] ?? '/home/alexxxnikolskiy/long_oi-proven-bundle.mjs';
const OUT_DIR = process.env['OUT_DIR'] ?? '/tmp';
const source = readFileSync(SRC, 'utf8');
const ENTRY = 'module/strategy.mjs';

// long_oi manifest meta (зеркало platform LONG_OI_MANIFEST). createModuleManifest допишет
// contractVersion/bundleContractVersion/author/status и опустит незаданные поля.
const { bundle, report } = scaffoldStrategyBundle({
  manifest: {
    id: 'long_oi',
    version: '1.0.0',
    kind: 'strategy',
    name: 'Long OI',
    summary: 'Long-only dump-reversal: вход после пролива с восстановлением OI/ликвидациями, DCA, TP-ладдер, BE.',
    rationale: 'detect dump → watch → confirm (OI-recovery + bounce + long-liq) → enter; in-position TP1/TP2/BE/DCA/fail_fast.',
    hooks: ['onBarClose', 'onPositionBar'],
    paramsSchema: { type: 'object', additionalProperties: true },
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true, openInterest: true, liquidations: true },
  },
  entry: ENTRY,
  files: { [ENTRY]: source },
});

console.log('[package] preflight status:', report.status);
if (report.issues.length) console.log('[package] issues:', JSON.stringify(report.issues, null, 1));
console.log('[package] manifest.contractVersion:', bundle.manifest.contractVersion);
console.log('[package] manifest.bundleContractVersion:', bundle.manifest.bundleContractVersion);
console.log('[package] manifest has null-поля?:',
  ['params', 'source', 'targetStrategyRef', 'interceptionPoint'].filter((k) => bundle.manifest[k] === null));

if (report.status === 'rejected') {
  console.error('[package] REJECTED — пакет не конформен');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, 'long_oi-bundle.json');
writeFileSync(outPath, JSON.stringify({ manifest: bundle.manifest, entry: bundle.entry, files: bundle.files }, null, 2) + '\n');
writeFileSync(join(OUT_DIR, 'long_oi-bundle.preflight.json'), JSON.stringify(report, null, 2) + '\n');
console.log('[package] конформный ModuleBundle →', outPath);
