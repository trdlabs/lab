// Д3 3.3в — допуск периода доезжает до СОХРАНЁННОГО прогона по КАЖДОМУ терминальному пути.
//
// ПОЧЕМУ ОДИН ТЕСТ НА ЧЕТЫРЕ ПУТИ, А НЕ ЧЕТЫРЕ РАЗНЫХ. Путей завершения здесь
// четыре, и они не производные друг от друга: общий tail (`applyPlatformTerminalOutcome`,
// он же обслуживает resume и callback) и три исполнителя — overlay-эксперимент,
// стратегический эксперимент и ревизия. Каждый строит свой completion сам. Ровно
// поэтому «проверили на одном» ничего не говорит об остальных: в бэктестере эта же
// ошибка уже случилась — evidence передавалась в две ветви из четырёх, а тест был
// зелёным.
//
// ЧТО ИМЕННО ПРОВЕРЯЕТСЯ — не наличие поля, а РАЗЛИЧИМОСТЬ:
//   - запрошенный период остаётся запрошенным (`platformRun` не переписан);
//   - effective отличается от него, и берётся ТОЛЬКО из допуска;
//   - обе идентичности («на чём решили» и «чем разрешили») различны и сохранены обе;
//   - источник без допуска оставляет NULL, а не синтезированный `effective = requested`.

import { describe, it, expect } from 'vitest';
import { applyPlatformTerminalOutcome } from './backtest-support.ts';
import { resumePlatformRun } from './resume-platform-backtest.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { InMemoryStrategyBacktestRunRepository } from '../../adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import { InMemoryBacktestRunRepository } from '../../adapters/repository/in-memory-backtest-run.repository.ts';
import { BacktesterExperimentRunExecutor } from '../../research/backtester-experiment-run-executor.ts';
import { BacktesterStrategyExperimentRunExecutor } from '../../research/backtester-strategy-experiment-run-executor.ts';
import { BacktesterRevisionRunExecutor } from '../../research/backtester-revision-run-executor.ts';
import { toBacktestDto } from '../../read-api/mappers.ts';
import type { AppServices } from '../app-services.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { RunAdmissionEvidence } from '../../ports/research-platform.port.ts';

const NOW = '2026-01-01T00:00:00Z';

/** ЗАПРОШЕНО шире доступного: январь–июнь. */
const REQUESTED = { from: '2023-01-01', to: '2023-06-30' };
const PLATFORM_RUN = { datasetId: 'ds', symbols: ['ETHUSDT'], timeframe: '1h', period: REQUESTED, seed: 7 };

/**
 * Допуск, у которого РАЗЛИЧАЕТСЯ всё, что обязано различаться: запрошенное против
 * фактического и первая идентичность против второй. На схлопнутых значениях тест
 * прошёл бы и там, где проводка теряет половину блока.
 */
const ADMISSION: RunAdmissionEvidence = {
  requestedFromMs: Date.parse('2023-01-01T00:00:00Z'),
  requestedToMs: Date.parse('2023-06-30T00:00:00Z'),
  effectiveFromMs: Date.parse('2023-02-15T00:00:00Z'),
  effectiveToMs: Date.parse('2023-05-20T00:00:00Z'),
  clamped: true,
  availabilityId: `sha256:${'a'.repeat(64)}`,
  asOfMs: 111,
  admittedAvailabilityId: `sha256:${'b'.repeat(64)}`,
  admittedAsOfMs: 222,
  archiveId: 'arch-1',
  datasetId: 'ds-1',
};

const RAW = { pnl: 1500, sharpe: 1.6, max_drawdown: 0.14, win_rate: 0.58, total_trades: 42, profit_factor: 2.1, top_trade_contribution_pct: 28 };
const BASE = { ...RAW, pnl: 800, profit_factor: 1.5 };

/** Completed-summary; `admission` кладётся только когда он есть — как у настоящего источника. */
function summary(admission?: RunAdmissionEvidence): never {
  return {
    runId: 'r-1', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
    metrics: BASE, comparison: { baseline: BASE, variant: RAW, deltas: {} },
    coverage: [], artifactRefs: [],
    evidence: { seed: 0, contractVersion: '017.5', moduleVersions: [], ...(admission ? { admission } : {}) },
  } as never;
}

function task(): ResearchTask {
  return { id: 't1', taskType: 'backtest.completed', source: 'operator', correlationId: 'c1', status: 'running', payload: {}, createdAt: NOW, updatedAt: NOW };
}

function run(over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id: 'run-1', hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'r-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh',
    status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1',
    backend: 'research_platform', taskId: 't1', resumeToken: 'tok', platformRun: PLATFORM_RUN,
    admission: null,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: 'builder-sdk-v0',
    submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

async function seed(s: AppServices, over: Partial<BacktestRun> = {}): Promise<BacktestRun> {
  await s.researchTasks.create(task());
  const r = run(over);
  await s.backtests.createSubmitted(r);
  return r;
}

/** Платформа, отвечающая заданным summary на всё. */
function platformReturning(s: unknown): never {
  return {
    discover: async () => { throw new Error('not used'); },
    listDatasets: async () => { throw new Error('not used'); },
    validateModule: async () => ({ status: 'accepted', issues: [], executed: false }),
    submitOverlayRun: async () => ({ jobId: 'j1', runId: 'r-1', status: 'accepted', effectiveSeed: 0, requestFingerprint: 'fp', idempotentReplay: false }),
    submitStrategyResearchRun: async () => ({ jobId: 'j1', runId: 'r-1', status: 'accepted', effectiveSeed: 0, requestFingerprint: 'fp', idempotentReplay: false }),
    getRunStatus: async () => ({ jobId: 'j1', runId: 'r-1', status: 'completed', timeline: { acceptedAtMs: 0 } }),
    getRunResult: async () => ({ ok: true, kind: 'summary', summary: s }),
  } as never;
}

const bundle = { manifest: { moduleId: 'mod-1', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['default'], capabilities: [], sdkContractVersion: 'builder-sdk-v0' }, files: { 'index.ts': '// stub' }, bundleHash: 'bundle-hash-abc', bundleContractVersion: 'module-bundle-v1' } as never;
const strategyBundle = { bytes: new Uint8Array(), source: '', manifest: { id: 'mod_x', version: '1', kind: 'strategy' }, bundleHash: 'sha256:h' } as never;
const RUN_CFG = { datasetId: 'ds-1', symbols: ['BTCUSDT'], timeframe: '1m', period: REQUESTED, seed: 42 };
const POLL = { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} };

describe('Д3 3.3в: допуск в сохранённом прогоне', () => {
  it('ПУТЬ 1 — общий tail: допуск сохранён, а ЗАПРОШЕННЫЙ период не тронут', async () => {
    const s = makeServices();
    await seed(s);
    await applyPlatformTerminalOutcome(
      s, task(),
      { runId: 'run-1', hypothesisId: 'h1', platformRunId: 'r-1' },
      { status: 'completed', runId: 'r-1', summary: summary(ADMISSION), artifactIds: [] } as never,
    );

    const row = await s.backtests.findById('run-1');
    expect(row?.admission).toEqual(ADMISSION);

    // Запрошенное осталось запрошенным. Перепиши его допуском — и в строке было бы
    // записано, что просили именно то, что разрешили; вопрос «сузили ли период»
    // стал бы неотвечаемым.
    expect(row?.platformRun?.period).toEqual(REQUESTED);

    // Effective ОТЛИЧАЕТСЯ от запрошенного и берётся только отсюда.
    expect(row?.admission?.effectiveFromMs).not.toBe(row?.admission?.requestedFromMs);
    expect(row?.admission?.effectiveToMs).not.toBe(row?.admission?.requestedToMs);
    expect(row?.admission?.clamped).toBe(true);

    // Две идентичности — обе, и они разные.
    expect(row?.admission?.availabilityId).not.toBe(row?.admission?.admittedAvailabilityId);
    expect(row?.admission?.asOfMs).toBe(111);
    expect(row?.admission?.admittedAsOfMs).toBe(222);
  });

  it('ПУТЬ 1б — resume/callback идут ТЕМ ЖЕ tail\'ом и тоже сохраняют допуск', async () => {
    // callback сам ничего не завершает: он ставит задачу backtest.resume, а
    // завершает уже resumePlatformRun. Поэтому достаточно проверить resume —
    // но проверить его НАДО, иначе «tail общий» остаётся заявлением.
    const s = makeServices({ researchPlatform: platformReturning(summary(ADMISSION)) });
    const r = await seed(s);
    await resumePlatformRun(s, r);

    const row = await s.backtests.findById('run-1');
    expect(row?.admission).toEqual(ADMISSION);
    expect(row?.platformRun?.period).toEqual(REQUESTED);
  });

  it('ПУТЬ 2 — overlay-эксперимент', async () => {
    const backtests = new InMemoryBacktestRunRepository();
    const exec = new BacktesterExperimentRunExecutor({
      platform: platformReturning(summary(ADMISSION)), backtests, poll: POLL,
      now: () => NOW, fragilityTopTradePct: 40,
    } as never);
    const out = await exec.execute({
      experimentId: 'e1', role: 'holdout', bundle, baselineRef: { id: 'baseline-1', version: 'v1' },
      strategyProfileId: 'p1', hypothesisId: 'h1', buildId: 'b1', run: RUN_CFG, params: {},
    } as never);

    expect(out.status).toBe('completed');
    expect((await backtests.findById(out.runId!))?.admission).toEqual(ADMISSION);
  });

  it('ПУТЬ 3 — стратегический эксперимент', async () => {
    const strategyBacktests = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: platformReturning(summary(ADMISSION)), strategyBacktests, poll: POLL, now: () => NOW,
    } as never);
    const out = await exec.execute({
      experimentId: 'e1', role: 'sanity', strategyBundle, strategyProfileId: 'p1',
      run: RUN_CFG, params: {}, metrics: ['netPnlUsd'],
    } as never);

    expect(out.status).toBe('completed');
    expect((await strategyBacktests.findById(out.runId!))?.admission).toEqual(ADMISSION);
  });

  it('ПУТЬ 4 — ревизия', async () => {
    const strategyBacktests = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterRevisionRunExecutor({
      platform: platformReturning(summary(ADMISSION)), strategyBacktests, poll: POLL, now: () => NOW,
    } as never);
    const out = await exec.execute({
      revisionId: 'rev-1', label: 'combo-1', strategyProfileId: 'p1', strategyBundle,
      run: RUN_CFG, params: {}, metrics: ['netPnlUsd'],
    } as never);

    expect(out.status).toBe('completed');
    expect((await strategyBacktests.findById(out.runId!))?.admission).toEqual(ADMISSION);
  });

  it('РАЗДЕЛЯЮЩАЯ: источник без допуска оставляет NULL — без синтеза effective = requested', async () => {
    const s = makeServices();
    await seed(s);
    await applyPlatformTerminalOutcome(
      s, task(),
      { runId: 'run-1', hypothesisId: 'h1', platformRunId: 'r-1' },
      { status: 'completed', runId: 'r-1', summary: summary(), artifactIds: [] } as never,
    );

    const row = await s.backtests.findById('run-1');
    // Именно NULL, а не «пустой допуск» и не копия запрошенного: «разрешения не
    // спрашивали» и «разрешили ровно запрошенное» — разные факты, и второе
    // утверждало бы то, чего никто не говорил.
    expect(row?.admission).toBeNull();
    expect(row?.status).toBe('evaluated');
    expect(row?.platformRun?.period).toEqual(REQUESTED);
  });

  it('in-memory round-trip: допуск переживает запись и чтение', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run());
    // При submit допуска ещё нет — он появляется атомарно с завершением.
    expect((await repo.findById('run-1'))?.admission).toBeNull();

    await repo.markCompleted('run-1', {
      admission: ADMISSION,
      metrics: { netPnlUsd: 1, netPnlPct: 1, totalTrades: 1, winRate: 1, profitFactor: 1, maxDrawdownPct: 1, expectancyUsd: 1, sharpe: 1, topTradeContributionPct: 1 },
      baselineMetrics: { netPnlUsd: 0, netPnlPct: 0, totalTrades: 1, winRate: 0, profitFactor: 0, maxDrawdownPct: 0, expectancyUsd: 0, sharpe: 0, topTradeContributionPct: 0 },
      deltaNetPnlUsd: 1, deltaMaxDrawdownPct: 1, isFragile: false, artifactRefs: [],
      platformContractVersion: '017.5', finishedAt: NOW,
    });
    expect((await repo.findById('run-1'))?.admission).toEqual(ADMISSION);
  });

  it('read-проекция не выбрасывает сохранённый блок, а его отсутствие не подменяет пустым', () => {
    // Проекция allow-list'овая: новое поле теряется по умолчанию. Здесь это ловится.
    expect(toBacktestDto(run({ admission: ADMISSION })).admission).toEqual(ADMISSION);
    expect('admission' in toBacktestDto(run({ admission: null }))).toBe(false);
  });
});
