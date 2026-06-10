import type { StrategyProfile } from '../domain/strategy-profile.ts';

export interface StrategyProfileRepository {
  create(profile: StrategyProfile): Promise<void>;
  findById(id: string): Promise<StrategyProfile | null>;
  findByFingerprint(sourceFingerprint: string): Promise<StrategyProfile | null>;
}
