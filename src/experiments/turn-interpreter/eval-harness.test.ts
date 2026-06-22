import { describe, it, expect } from 'vitest';
import { runEval } from './eval-harness.ts';
import type { EvalCase } from './types.ts';
import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';

const cases: EvalCase[] = [
  { id: 'a', lang: 'en', message: 'research BTCUSDT 1h long', expect: { subject: 'strategy', goal: 'research' } },
];

function fakeInterpreter(modelId: string): TurnInterpreterPort {
  return {
    adapter: 'fake', model: modelId,
    interpret: async () => ({ subject: 'strategy', goal: 'research', constraints: {}, references: [], confidence: 0.9 }),
  };
}

describe('runEval', () => {
  it('runs model-major and aggregates per model', async () => {
    const res = await runEval(
      { models: ['m1', 'm2'], datasetId: 'd', cases, datasetFingerprint: 'fp', threshold: 0.75, repeat: 1 },
      { interpreterFor: (m) => fakeInterpreter(m), providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    expect(res.aggregates.map((a) => a.modelId)).toEqual(['m1', 'm2']);
    expect(res.aggregates[0]!.passRate).toBe(1);
    expect(res.manifest.caseCount).toBe(1);
  });

  it('isolates a model that fails to build', async () => {
    const res = await runEval(
      { models: ['ok', 'broken'], datasetId: 'd', cases, datasetFingerprint: 'fp', threshold: 0.75, repeat: 1 },
      { interpreterFor: (m) => { if (m === 'broken') throw new Error('no key'); return fakeInterpreter(m); },
        providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    const broken = res.candidates.find((c) => c.modelId === 'broken')!;
    expect(broken.ok).toBe(false);
    const ok = res.candidates.find((c) => c.modelId === 'ok')!;
    expect(ok.ok).toBe(true);
  });

  it('a throwing interpret() is a schema-invalid miss, not a crash', async () => {
    const res = await runEval(
      { models: ['m'], datasetId: 'd', cases, datasetFingerprint: 'fp', threshold: 0.75, repeat: 1 },
      { interpreterFor: () => ({ adapter: 'fake', model: 'm', interpret: async () => { throw new Error('boom'); } }),
        providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    const cand = res.candidates[0]!;
    expect(cand.ok).toBe(true);
    expect(cand.result?.schemaValidRate).toBe(0);
  });
});
