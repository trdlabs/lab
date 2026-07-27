// Калибровочное окно T2 (control-center runbook battery-t2-mock-staging-window): операторский
// env-override порогов trade_based-сплита. Без переменных возвращает undefined — вызывающий
// (scripts/run-strategy-baseline.mts) остаётся на DEFAULT_HOLDOUT_POLICY, прод-поведение
// не меняется. Fail-fast на невалидных значениях: тихий дефолт при опечатке дал бы серию
// с неожиданными порогами.
import { DEFAULT_HOLDOUT_POLICY, type HoldoutPolicy } from '../domain/research-experiment.ts';

const KEYS = [
  ['HOLDOUT_MIN_TRADES_TRAIN', 'minTradesTrain'],
  ['HOLDOUT_MIN_TRADES_HOLDOUT', 'minTradesHoldout'],
  ['HOLDOUT_MIN_HISTORY_DAYS', 'minHistoryDays'],
  ['HOLDOUT_LOW_CONFIDENCE_THRESHOLD', 'lowConfidenceThreshold'],
] as const;

export function holdoutPolicyFromEnv(env: Record<string, string | undefined>): HoldoutPolicy | undefined {
  const overrides: Partial<Record<(typeof KEYS)[number][1], number>> = {};
  for (const [envKey, field] of KEYS) {
    const raw = env[envKey];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${envKey} must be a positive integer, got '${raw}'`);
    }
    overrides[field] = n;
  }
  if (Object.keys(overrides).length === 0) return undefined;
  return { ...DEFAULT_HOLDOUT_POLICY, ...overrides };
}
