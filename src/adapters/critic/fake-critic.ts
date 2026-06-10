import type { CriticPort } from '../../ports/critic.port.ts';
import type { CriticInput, CriticOutput } from '../../domain/critic.ts';

export class FakeCritic implements CriticPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';

  async review(input: CriticInput): Promise<CriticOutput> {
    return { verdict: 'ok', concerns: [], summary: `Fake critic reviewed: ${input.proposal.thesis.slice(0, 60)}` };
  }
}
