import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { StrategyProfileRepository } from '../../ports/strategy-profile.repository.ts';

export class InMemoryStrategyProfileRepository implements StrategyProfileRepository {
  private readonly byId = new Map<string, StrategyProfile>();

  async create(profile: StrategyProfile): Promise<void> {
    if (this.byId.has(profile.id)) throw new Error(`strategy_profile already exists: ${profile.id}`);
    for (const p of this.byId.values()) {
      if (p.sourceFingerprint === profile.sourceFingerprint) {
        throw new Error(`strategy_profile already exists for fingerprint: ${profile.sourceFingerprint}`);
      }
    }
    this.byId.set(profile.id, { ...profile });
  }

  async findById(id: string): Promise<StrategyProfile | null> {
    return this.byId.get(id) ?? null;
  }

  async findByFingerprint(sourceFingerprint: string): Promise<StrategyProfile | null> {
    for (const p of this.byId.values()) {
      if (p.sourceFingerprint === sourceFingerprint) return p;
    }
    return null;
  }
}
