import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ENV_SCHEMA_VERSION,
  ENV_VARIABLE_TYPES,
  FLAG_STATES,
  envSchemaDocument,
  renderEnvSchemaJson,
  renderEnvMd,
  type EnvSchemaDocument,
} from './env-schema.ts';
import { loadEnv } from './env.ts';

// ---------------------------------------------------------------------------
// Локальная копия семантических правил контракта env-schema.1 (control-center
// docs/architecture/contracts/env-schema.md + scripts/src/contracts/env-schema.ts).
// Порт validateEnvSchemaDocument: структурные правила JSON Schema + 4 правила,
// которые JSON Schema не выражает (уникальность имён, сортировка,
// default_state ∈ flag_states, default флага == default_state).
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REPO_PATTERN = /^[a-z][a-z0-9-]*$/;

function validateContract(doc: unknown): string[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return ['document must be an object'];
  const errors: string[] = [];
  const record = doc as Record<string, unknown>;

  // Правило 1: schema_version — константа env-schema.1.
  if (record.schema_version !== 'env-schema.1') errors.push(`bad schema_version ${JSON.stringify(record.schema_version)}`);
  // Правило 2: repo — канонический id из repos.yaml.
  if (typeof record.repo !== 'string' || !REPO_PATTERN.test(record.repo)) errors.push('bad repo');
  // Правило 3: generated_from — repo-относительный путь.
  if (
    typeof record.generated_from !== 'string' ||
    record.generated_from.length === 0 ||
    record.generated_from.startsWith('/') ||
    record.generated_from.split('/').includes('..')
  ) {
    errors.push('bad generated_from');
  }
  // Правило 4: никаких неизвестных полей (верхний уровень и переменные).
  const knownTop = new Set(['schema_version', 'repo', 'generated_from', 'variables']);
  for (const key of Object.keys(record)) if (!knownTop.has(key)) errors.push(`unknown top-level field "${key}"`);

  if (!Array.isArray(record.variables)) {
    errors.push('variables must be an array');
    return errors;
  }

  const seen = new Set<string>();
  let prev: string | null = null;
  record.variables.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`variables[${i}]: not an object`);
      return;
    }
    const v = entry as Record<string, unknown>;
    const where = `variables[${i}] (${String(v.name)})`;

    const knownFields = new Set([
      'name', 'type', 'required', 'default', 'description', 'secret', 'flag',
      'enum_values', 'flag_states', 'default_state', 'owner_unit', 'consumers',
    ]);
    for (const key of Object.keys(v)) if (!knownFields.has(key)) errors.push(`${where}: unknown field "${key}"`);

    // Правило 5: имя по паттерну + уникально.
    if (typeof v.name !== 'string' || !NAME_PATTERN.test(v.name)) errors.push(`${where}: bad name`);
    if (typeof v.name === 'string') {
      if (seen.has(v.name)) errors.push(`${where}: duplicate name`);
      seen.add(v.name);
      // Правило 6: сортировка по name (UTF-16 code units).
      if (prev !== null && prev > v.name) errors.push(`${where}: not sorted ("${v.name}" after "${prev}")`);
      prev = v.name;
    }
    // Правило 7: тип из фиксированного словаря.
    if (typeof v.type !== 'string' || !(ENV_VARIABLE_TYPES as readonly string[]).includes(v.type)) {
      errors.push(`${where}: unknown type ${JSON.stringify(v.type)}`);
    }
    // Правило 8: формы полей.
    for (const f of ['required', 'secret', 'flag'] as const) {
      if (typeof v[f] !== 'boolean') errors.push(`${where}: ${f} must be boolean`);
    }
    if (!('default' in v) || (v.default !== null && typeof v.default !== 'string')) errors.push(`${where}: bad default`);
    if (typeof v.description !== 'string' || v.description.trim().length === 0) errors.push(`${where}: empty description`);
    if (typeof v.owner_unit !== 'string' || v.owner_unit.trim().length === 0) errors.push(`${where}: empty owner_unit`);
    if (!Array.isArray(v.consumers) || v.consumers.some((c) => typeof c !== 'string' || c.length === 0)) {
      errors.push(`${where}: bad consumers`);
    }
    // Правило 9: secret ⇒ default null (схема описывает форму, не значение).
    if (v.secret === true && v.default !== null) errors.push(`${where}: secret must not carry a default`);
    // Правило 10: required ⇒ default null.
    if (v.required === true && v.default !== null && v.default !== undefined) errors.push(`${where}: required must not carry a default`);
    // Правило 11: enum ⇔ enum_values (непустой, уникальный).
    if (v.type === 'enum' && !('enum_values' in v)) errors.push(`${where}: enum requires enum_values`);
    if ('enum_values' in v) {
      if (v.type !== 'enum') errors.push(`${where}: enum_values only for type enum`);
      if (
        !Array.isArray(v.enum_values) ||
        v.enum_values.length === 0 ||
        v.enum_values.some((x) => typeof x !== 'string' || x.length === 0) ||
        new Set(v.enum_values).size !== v.enum_values.length
      ) {
        errors.push(`${where}: bad enum_values`);
      }
    }
    // Правило 12: флаги — E4b: flag_states ⊆ off|log|enforce, default_state ∈ flag_states,
    // флаг не required, default (если задан) == default_state; для не-флагов flag-полей нет.
    if (v.flag === true) {
      if (
        !Array.isArray(v.flag_states) ||
        v.flag_states.length === 0 ||
        new Set(v.flag_states).size !== v.flag_states.length ||
        v.flag_states.some((s) => !(FLAG_STATES as readonly string[]).includes(s as string))
      ) {
        errors.push(`${where}: bad flag_states`);
      }
      if (
        typeof v.default_state !== 'string' ||
        !(FLAG_STATES as readonly string[]).includes(v.default_state) ||
        (Array.isArray(v.flag_states) && !v.flag_states.includes(v.default_state))
      ) {
        errors.push(`${where}: bad default_state`);
      }
      if (v.required === true) errors.push(`${where}: flag must not be required`);
      if (v.default !== null && v.default !== undefined && v.default !== v.default_state) {
        errors.push(`${where}: flag default must equal default_state`);
      }
    } else {
      if ('flag_states' in v) errors.push(`${where}: flag_states only for flags`);
      if ('default_state' in v) errors.push(`${where}: default_state only for flags`);
    }
  });

  return errors;
}

function byName(doc: EnvSchemaDocument, name: string) {
  return doc.variables.find((v) => v.name === name);
}

describe('env-schema.1 export (env-catalog item 4)', () => {
  const doc = envSchemaDocument();

  it('проходит все правила контракта env-schema.1 (пустой список ошибок)', () => {
    expect(validateContract(doc)).toEqual([]);
  });

  it('верхний уровень: repo trading-lab, generated_from src/config/env.ts', () => {
    expect(doc.schema_version).toBe(ENV_SCHEMA_VERSION);
    expect(doc.repo).toBe('trading-lab');
    expect(doc.generated_from).toBe('src/config/env.ts');
    expect(doc.variables.length).toBeGreaterThan(100);
  });

  it('детерминизм: два вызова дают байт-в-байт одинаковый JSON с завершающим \\n', () => {
    const a = renderEnvSchemaJson();
    const b = renderEnvSchemaJson();
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).toBe(JSON.stringify(envSchemaDocument(), null, 2) + '\n');
  });
});

describe('env-schema: доменные инварианты lab', () => {
  const doc = envSchemaDocument();

  it('LAB_BREAK_BATTERY_MODE — флаг off|log, default off, enforce отклонён до item 7', () => {
    const v = byName(doc, 'LAB_BREAK_BATTERY_MODE');
    expect(v).toBeDefined();
    expect(v!.flag).toBe(true);
    expect(v!.type).toBe('enum');
    expect(v!.enum_values).toEqual(['off', 'log']);
    expect(v!.flag_states).toEqual(['off', 'log']);
    expect(v!.default_state).toBe('off');
    expect(v!.default).toBe('off');
    // enforce намеренно отклоняется до пиновки порогов (research-validation-hardening item 7)
    expect(v!.description).toMatch(/enforce/);
    expect(v!.description).toMatch(/item 7/);
  });

  it('LAB_HYPOTHESIS_HOLDOUT — флаг off|log, default off, enforce отклонён до калибровки батареи', () => {
    const v = byName(doc, 'LAB_HYPOTHESIS_HOLDOUT');
    expect(v).toBeDefined();
    expect(v!.flag).toBe(true);
    expect(v!.type).toBe('enum');
    expect(v!.enum_values).toEqual(['off', 'log']);
    expect(v!.flag_states).toEqual(['off', 'log']);
    expect(v!.default_state).toBe('off');
    expect(v!.default).toBe('off');
    // enforce намеренно отклоняется до калибровки порогов (battery-policy@1)
    expect(v!.description).toMatch(/enforce/);
    expect(v!.description).toMatch(/калибр/);
  });

  it('все токены/ключи — secret с default null', () => {
    const secretByPattern = doc.variables.filter((v) => /_(TOKEN|KEY)$/.test(v.name));
    expect(secretByPattern.length).toBeGreaterThanOrEqual(10);
    for (const v of secretByPattern) {
      expect(v.secret, `${v.name} must be secret`).toBe(true);
      expect(v.default, `${v.name} secret default must be null`).toBeNull();
    }
    // Connection strings несут креды — тоже secret.
    for (const name of ['DATABASE_URL', 'REDIS_URL']) {
      expect(byName(doc, name)?.secret, `${name} must be secret`).toBe(true);
    }
    // Все TRADING_LAB_* токены объявлены.
    for (const name of [
      'TRADING_LAB_READ_TOKEN',
      'TRADING_LAB_CHAT_TOKEN',
      'TRADING_LAB_TASK_TOKEN',
      'TRADING_LAB_CALLBACK_TOKEN',
    ]) {
      expect(byName(doc, name), `${name} must be declared`).toBeDefined();
    }
  });

  it('LAB_U6_IMAGE объявлена как деплой-переменная compose (owner_unit lab-u6)', () => {
    const v = byName(doc, 'LAB_U6_IMAGE');
    expect(v).toBeDefined();
    expect(v!.owner_unit).toBe('lab-u6');
    expect(v!.consumers).toContain('docker-compose.vps.yml');
    expect(v!.secret).toBe(false);
  });

  it('селекторные оси (LAB_SIGNED_EVIDENCE_SOURCE, LAB_BOT_RESULTS_INTEGRATION, paper-intake) объявлены', () => {
    expect(byName(doc, 'LAB_SIGNED_EVIDENCE_SOURCE')?.enum_values).toEqual(['none', 'fixture', 'http']);
    expect(byName(doc, 'LAB_BOT_RESULTS_INTEGRATION')?.enum_values).toEqual(['mock', 'fixture', 'http']);
    expect(byName(doc, 'LAB_PAPER_INTAKE_URL')).toBeDefined();
    expect(byName(doc, 'LAB_PAPER_INTAKE_TOKEN')?.secret).toBe(true);
    expect(byName(doc, 'LAB_OPS_READ_TOKEN')?.secret).toBe(true);
  });
});

describe('env-schema: полнота относительно loadEnv (единственная точка чтения)', () => {
  const doc = envSchemaDocument();
  const declared = new Set(doc.variables.map((v) => v.name));

  // Ключи Env, которые агрегируют несколько переменных окружения.
  const AGGREGATES: Record<string, string[]> = {
    evaluatorThresholds: [
      'EVAL_MIN_TRADES',
      'EVAL_MIN_PNL_DELTA_USD',
      'EVAL_MAX_DRAWDOWN_TOLERANCE_PCT',
      'EVAL_FRAGILITY_TOP_TRADE_PCT',
      'EVAL_STRONG_PNL_DELTA_USD',
      'EVAL_MIN_PROFIT_FACTOR',
    ],
    preservationGateEnabled: ['LAB_TRADE_PRESERVATION_GATE'],
    preservationThresholds: [
      'LAB_TRADE_PRESERVATION_WINNER_RETENTION',
      'LAB_TRADE_PRESERVATION_MAX_TRADE_DROP_PCT',
      'LAB_TRADE_PRESERVATION_ABSTENTION_SHARE',
      'LAB_TRADE_PRESERVATION_EOD_SHARE',
      'LAB_TRADE_PRESERVATION_MATCH_TOLERANCE_MS',
      'LAB_TRADE_PRESERVATION_MIN_WINNER_SAMPLE',
    ],
  };

  // Ключи Env, зашитые в код константой и НЕ читаемые из process.env — в каталог не входят.
  const HARDCODED = new Set(['BACKTEST_BACKEND', 'OPERATOR_EMBEDDING_PROVIDER']);

  it('каждый UPPER_CASE-ключ loadEnv объявлен в схеме (или в явном списке исключений)', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    const missing: string[] = [];
    for (const key of Object.keys(env)) {
      if (!/^[A-Z]/.test(key)) continue; // camelCase-агрегаты покрыты AGGREGATES
      if (HARDCODED.has(key)) continue;
      if (!declared.has(key)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it('агрегатные ключи Env покрыты подлежащими переменными', () => {
    for (const names of Object.values(AGGREGATES)) {
      for (const name of names) {
        expect(declared.has(name), `${name} must be declared`).toBe(true);
      }
    }
    // LAB_AGENTS_ADAPTER читается loadEnv как общий дефолт адаптеров — обязана быть объявлена.
    expect(declared.has('LAB_AGENTS_ADAPTER')).toBe(true);
  });

  it('нестрогие дефолты схемы совпадают с фактическим поведением loadEnv({})', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv) as unknown as Record<string, unknown>;
    for (const v of doc.variables) {
      if (v.default === null) continue;
      if (!(v.name in env)) continue; // селекторные/деплой/агрегатные переменные
      const actual = env[v.name];
      switch (v.type) {
        case 'int':
        case 'float':
        case 'duration_ms':
          expect(actual, v.name).toBe(Number(v.default));
          break;
        case 'bool':
          expect(actual, v.name).toBe(v.default === 'true');
          break;
        default:
          expect(actual, v.name).toBe(v.default);
      }
    }
  });
});

describe('env-schema: fail-fast loadEnv сохранён (негативы)', () => {
  it('enforce для LAB_BREAK_BATTERY_MODE отклоняется', () => {
    expect(() => loadEnv({ LAB_BREAK_BATTERY_MODE: 'enforce' } as NodeJS.ProcessEnv)).toThrow(/enforce/);
  });
  it('неизвестные значения fail-closed осей бросают', () => {
    expect(() => loadEnv({ TRADING_PLATFORM_INTEGRATION: 'backtestr' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadEnv({ LAB_AGENTS_ADAPTER: 'Mastra' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadEnv({ OPERATOR_EMBEDDING_DIMENSIONS: '512' } as NodeJS.ProcessEnv)).toThrow(/1024/);
    expect(() => loadEnv({ LAB_TRUSTED_SIGNERS_JSON: '{oops' } as NodeJS.ProcessEnv)).toThrow(/JSON/);
  });
});

describe('env-schema: негативы локального валидатора контракта', () => {
  const base = envSchemaDocument();

  it('ловит дубликат имени', () => {
    const doc = structuredClone(base) as EnvSchemaDocument;
    doc.variables.push({ ...doc.variables[0]! });
    expect(validateContract(doc).join('\n')).toMatch(/duplicate|not sorted/);
  });

  it('ловит нарушение сортировки', () => {
    const doc = structuredClone(base) as EnvSchemaDocument;
    doc.variables.reverse();
    expect(validateContract(doc).some((e) => e.includes('not sorted'))).toBe(true);
  });

  it('ловит secret с default', () => {
    const doc = structuredClone(base) as EnvSchemaDocument;
    const secret = doc.variables.find((v) => v.secret)!;
    (secret as { default: string | null }).default = 'oops';
    expect(validateContract(doc).some((e) => e.includes('secret must not carry a default'))).toBe(true);
  });

  it('ловит default_state вне flag_states и неизвестный тип', () => {
    const doc = structuredClone(base) as EnvSchemaDocument;
    const flag = doc.variables.find((v) => v.flag)!;
    (flag as { default_state: string }).default_state = 'enforce';
    (flag as { default: string | null }).default = null;
    const errors = validateContract(doc);
    expect(errors.some((e) => e.includes('bad default_state'))).toBe(true);

    const doc2 = structuredClone(base) as EnvSchemaDocument;
    (doc2.variables[0] as { type: string }).type = 'trilean';
    expect(validateContract(doc2).some((e) => e.includes('unknown type'))).toBe(true);
  });

  it('ловит флаг без flag_states', () => {
    const doc = structuredClone(base) as EnvSchemaDocument;
    const flag = doc.variables.find((v) => v.flag)! as unknown as Record<string, unknown>;
    delete flag.flag_states;
    expect(validateContract(doc).some((e) => e.includes('bad flag_states'))).toBe(true);
  });
});

describe('ENV.md генерируется из схемы', () => {
  it('ENV.md в корне репо байт-в-байт совпадает с рендером схемы (pnpm env:docs)', () => {
    const envMdPath = fileURLToPath(new URL('../../ENV.md', import.meta.url));
    const onDisk = readFileSync(envMdPath, 'utf8');
    expect(onDisk).toBe(renderEnvMd());
  });

  it('рендер содержит все переменные и не содержит значений секретов', () => {
    const md = renderEnvMd();
    for (const v of envSchemaDocument().variables) {
      expect(md, v.name).toContain(`\`${v.name}\``);
    }
    // secret-переменные рендерятся без default (default null по контракту) и помечены как secret
    for (const v of envSchemaDocument().variables.filter((s) => s.secret)) {
      const row = md.split('\n').find((line) => line.startsWith(`| \`${v.name}\``));
      expect(row, v.name).toBeDefined();
      const cells = row!.split('|').map((c) => c.trim());
      expect(cells[4], `${v.name} default cell`).toBe('—');
      expect(cells[5], `${v.name} secret cell`).toBe('да');
    }
  });
});
