import type { CriticInput, CriticOutput } from '../domain/critic.ts';

export interface CriticPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  review(input: CriticInput): Promise<CriticOutput>;
}
