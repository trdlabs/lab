import { describe, it, expect } from 'vitest';
import { buildGate1, buildSweepDesigner, buildResultInterpreter } from './composition.ts';
import { loadEnv } from './config/env.ts';
import { composeMastra } from './mastra/compose-mastra.ts';

function envWith(over: Record<string, string>) {
  return loadEnv({ ...over } as unknown as NodeJS.ProcessEnv);
}

describe('buildGate1 / buildSweepDesigner / buildResultInterpreter — WFO agent wiring', () => {
  it('wires fakes by default (WFO_*_ADAPTER unset)', () => {
    const env = envWith({});
    const rt = composeMastra(env);

    const gate1 = buildGate1(env, rt);
    const sweepDesigner = buildSweepDesigner(env, rt);
    const resultInterpreter = buildResultInterpreter(env, rt);

    expect(gate1.adapter).toBe('fake');
    expect(sweepDesigner.adapter).toBe('fake');
    expect(resultInterpreter.adapter).toBe('fake');
  });

  it('wires fakes when WFO_*_ADAPTER=fake explicitly', () => {
    const env = envWith({
      WFO_GATE1_ADAPTER: 'fake',
      WFO_SWEEP_DESIGNER_ADAPTER: 'fake',
      WFO_RESULT_INTERPRETER_ADAPTER: 'fake',
    });
    const rt = composeMastra(env);

    expect(buildGate1(env, rt).adapter).toBe('fake');
    expect(buildSweepDesigner(env, rt).adapter).toBe('fake');
    expect(buildResultInterpreter(env, rt).adapter).toBe('fake');
  });

  it('wires real Mastra agents when WFO_*_ADAPTER=mastra with a resolvable model', () => {
    const env = envWith({
      WFO_GATE1_ADAPTER: 'mastra',
      WFO_GATE1_MODEL: 'anthropic/claude-sonnet-4-6',
      WFO_SWEEP_DESIGNER_ADAPTER: 'mastra',
      WFO_SWEEP_DESIGNER_MODEL: 'anthropic/claude-sonnet-4-6',
      WFO_RESULT_INTERPRETER_ADAPTER: 'mastra',
      WFO_RESULT_INTERPRETER_MODEL: 'anthropic/claude-sonnet-4-6',
      MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'dummy',
    });
    const rt = composeMastra(env);

    const gate1 = buildGate1(env, rt);
    const sweepDesigner = buildSweepDesigner(env, rt);
    const resultInterpreter = buildResultInterpreter(env, rt);

    expect(gate1.adapter).toBe('mastra');
    expect(sweepDesigner.adapter).toBe('mastra');
    expect(resultInterpreter.adapter).toBe('mastra');
  });

  it('falls back to fakes with a warning when WFO_*_ADAPTER=mastra but the agent is missing from the runtime', () => {
    const env = envWith({ WFO_GATE1_ADAPTER: 'mastra', WFO_GATE1_MODEL: 'anthropic/claude-sonnet-4-6' });
    // rt built from a DIFFERENT env (no adapters=mastra) so rt.agents.gate1 is undefined, forcing the fallback branch.
    const rtWithoutAgents = composeMastra(envWith({}));

    expect(buildGate1(env, rtWithoutAgents).adapter).toBe('fake');
  });
});
