export interface CriticReview {
  verdict: 'pass' | 'concerns' | 'reject';
  issues: string[];
}

export interface CriticPort {
  review(input: unknown): Promise<CriticReview>;
}

/**
 * SP-1 default. The real LLM Critic is added in SP-3 behind ENABLE_CRITIC_AGENT.
 * The mandatory gate is always the deterministic Validator, never the Critic.
 */
export class NoopCritic implements CriticPort {
  async review(_input: unknown): Promise<CriticReview> {
    return { verdict: 'pass', issues: [] };
  }
}
