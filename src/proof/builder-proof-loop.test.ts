import { describe, it, expect } from 'vitest';
import { FakeStrategyBuilder } from '../adapters/builder/fake-strategy-builder.ts';
import { runBuilderProofLoop } from './builder-proof-loop.ts';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';
import type { StrategyBuilder, StrategyBuilderInput, StrategyBuilderOutput, BuildFeedback } from '../ports/strategy-builder.port.ts';
import { AmbientBuilder } from './builder-proof-loop.fixtures.ts';

const INPUT = {
  spec: { goal: 'long oi rebound' },
  authoringDoc: 'doc',
  profile: undefined,
} as unknown as StrategyBuilderInput;

class ScriptedProver implements BundleProverPort {
  private i = 0;
  constructor(private readonly verdicts: ProofVerdict[]) {}
  async prove(): Promise<ProofVerdict> { return this.verdicts[this.i++]!; }
}

class RecordingBuilder implements StrategyBuilder {
  readonly adapter = 'rec';
  readonly model = 'rec';
  readonly feedbacks: (BuildFeedback | undefined)[] = [];
  private readonly inner = new FakeStrategyBuilder();
  async build(i: StrategyBuilderInput): Promise<StrategyBuilderOutput> {
    this.feedbacks.push(i.feedback);
    return this.inner.build(i);
  }
}

describe('runBuilderProofLoop', () => {
  it('proven на первой попытке → attempts=1', async () => {
    const outcome = await runBuilderProofLoop({
      builder: new FakeStrategyBuilder(),
      prover: new ScriptedProver([{ proven: true }]),
      input: INPUT,
    });
    expect(outcome.proven).toBe(true);
    expect(outcome.attempts).toBe(1);
    // G2: proven несёт собранный бандл для paper-intake.
    expect(outcome.bundle).toBeDefined();
    expect(typeof outcome.bundle?.bundleHash).toBe('string');
    expect(outcome.bundle?.source.length).toBeGreaterThan(0);
  });

  it('divergence → parity-feedback → proven на 2-й попытке', async () => {
    const builder = new RecordingBuilder();
    const outcome = await runBuilderProofLoop({
      builder,
      prover: new ScriptedProver([
        { proven: false, divergence: { bar: 14, field: 'qty', expected: 1, actual: 1.5 } },
        { proven: true },
      ]),
      input: INPUT,
    });
    expect(outcome.proven).toBe(true);
    expect(outcome.attempts).toBe(2);
    // 1-я попытка — без feedback; 2-я — parity-feedback от divergence
    expect(builder.feedbacks[0]).toBeUndefined();
    expect(builder.feedbacks[1]).toEqual({ kind: 'parity', diff: { bar: 14, field: 'qty', expected: 1, actual: 1.5 } });
  });

  it('L2 reject (ambient) → validation-feedback, prover не вызывается, исчерпание maxIters', async () => {
    let proverCalls = 0;
    const prover: BundleProverPort = { async prove() { proverCalls += 1; return { proven: true }; } };
    const outcome = await runBuilderProofLoop({ builder: new AmbientBuilder(), prover, input: INPUT, maxIterations: 3 });
    expect(outcome.proven).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(proverCalls).toBe(0); // L2 отсекает до платформенного prove
    // validateStrategyBundle: process.env → violations=['process_access'], reason='forbidden_ambient_authority'
    // runBuilderProofLoop хранит verdict.violations в lastViolations, а не reason
    expect(outcome.lastViolations).toContain('process_access');
  });

  it('platform failClosed → validation-feedback, до исчерпания', async () => {
    const builder = new RecordingBuilder();
    const outcome = await runBuilderProofLoop({
      builder,
      prover: new ScriptedProver([
        { proven: false, failClosed: { reason: 'runtime_error:boom' } },
        { proven: true },
      ]),
      input: INPUT,
    });
    expect(outcome.proven).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(builder.feedbacks[1]).toEqual({ kind: 'validation', violations: ['runtime_error:boom'] });
  });

  it('исчерпание maxIters при стойком divergence → proven:false + lastVerdict', async () => {
    const div: ProofVerdict = { proven: false, divergence: { bar: 1, field: 'qty', expected: 1, actual: 2 } };
    const outcome = await runBuilderProofLoop({
      builder: new FakeStrategyBuilder(),
      prover: new ScriptedProver([div, div]),
      input: INPUT,
      maxIterations: 2,
    });
    expect(outcome.proven).toBe(false);
    expect(outcome.attempts).toBe(2);
    expect(outcome.lastVerdict).toEqual(div);
  });
});
