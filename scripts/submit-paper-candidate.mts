// G2 (2026-07-03): вызываемый триггер lab→platform — отправить proven-бандл в
// платформенный intake paper-кандидатов с identity-полями. Оркестратор sweep
// подключит PaperIntakePort программно; CLI закрывает ручной/скриптовый запуск.
//
//   LAB_PAPER_INTAKE_URL=http://127.0.0.1:8842 npx tsx scripts/submit-paper-candidate.mts \
//     --bundle .artifacts/long-oi-llm-bundle.mjs --strategy-name long_oi_llm --side long \
//     --dataset vps-slice-2026-06-29 --symbols INUSDT,TAIKOUSDT --from 2026-06-29 --to 2026-07-01 \
//     --baseline-run run-base --variant-run run-var --summary "llm variant beats baseline" \
//     [--params-json '{"warmup":{"candlesMin":20}}'] [--idempotency-key champ-1]

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { selectPaperIntake } from '../src/adapters/platform/paper-intake.port.ts';

const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const req = (name: string): string => {
  const v = arg(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
};

const bundlePath = req('bundle');
const side = req('side');
if (side !== 'long' && side !== 'short') {
  console.error(`--side must be long|short (платформа проецирует только их), got '${side}'`);
  process.exit(2);
}
const bytes = readFileSync(bundlePath);
const bundleHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const paramsRaw = arg('params-json');

const port = selectPaperIntake(process.env);
if (!port.enabled) {
  console.error('paper-intake disabled: set LAB_PAPER_INTAKE_URL');
  process.exit(2);
}

const res = await port.submitProvenCandidate({
  bundle: { bundleHash },
  identity: {
    strategyName: req('strategy-name'),
    side,
    ...(paramsRaw ? { params: JSON.parse(paramsRaw) as Record<string, unknown> } : {}),
  },
  evidence: {
    baselineRunId: req('baseline-run'),
    variantRunId: req('variant-run'),
    datasetRef: req('dataset'),
    window: { fromMs: Date.parse(req('from')), toMs: Date.parse(req('to')) },
    symbols: req('symbols').split(',').map((s) => s.trim()).filter(Boolean),
    timeframe: arg('timeframe', '1m') as string,
    metricsSnapshot: { submittedVia: 'submit-paper-candidate-cli' },
    improvementSummary: req('summary'),
  },
  idempotencyKey: arg('idempotency-key', `cli-${bundleHash.slice(7, 19)}`) as string,
  workflowId: arg('workflow-id'),
});

console.log(JSON.stringify(res));
process.exit(res.ok ? 0 : 1);
