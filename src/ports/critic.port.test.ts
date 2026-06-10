// SP-3: CriticPort interface is now in domain/critic.ts + ports/critic.port.ts.
// The SP-1 NoopCritic has been superseded by FakeCritic (src/adapters/critic/fake-critic.ts).
// See fake-critic.test.ts for the authoritative FakeCritic tests.
import { describe, it, expect } from 'vitest';

describe('CriticPort (SP-3)', () => {
  it('module exists', async () => {
    const mod = await import('./critic.port.ts');
    // The module exports the CriticPort interface; no runtime value to assert beyond import success.
    expect(mod).toBeDefined();
  });
});
