import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { strategyProfile } from '../../db/schema.ts';
import type { StrategyProfile, AnalystProfileOutput, Direction } from '../../domain/strategy-profile.ts';
import type { SourceKind } from '../../domain/strategy-source.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type { StrategyProfileRepository } from '../../ports/strategy-profile.repository.ts';

type Row = typeof strategyProfile.$inferSelect;

function toDomain(row: Row): StrategyProfile {
  return {
    id: row.id,
    version: row.version,
    sourceKind: row.sourceKind as SourceKind,
    sourceFingerprint: row.sourceFingerprint,
    direction: row.direction as Direction,
    coreIdea: row.coreIdea,
    requiredMarketFeatures: row.requiredMarketFeatures,
    confidence: row.confidence,
    unknowns: row.unknowns,
    profile: row.profile as AnalystProfileOutput,
    sourceArtifactRef: row.sourceArtifactRef as ArtifactRef,
    contractVersion: row.contractVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleStrategyProfileRepository implements StrategyProfileRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(profile: StrategyProfile): Promise<void> {
    await this.db.insert(strategyProfile).values({
      id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      sourceFingerprint: profile.sourceFingerprint, direction: profile.direction, coreIdea: profile.coreIdea,
      requiredMarketFeatures: profile.requiredMarketFeatures, confidence: profile.confidence,
      unknowns: profile.unknowns, profile: profile.profile, sourceArtifactRef: profile.sourceArtifactRef,
      contractVersion: profile.contractVersion,
      createdAt: new Date(profile.createdAt), updatedAt: new Date(profile.updatedAt),
    });
  }

  async findById(id: string): Promise<StrategyProfile | null> {
    const rows = await this.db.select().from(strategyProfile).where(eq(strategyProfile.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByFingerprint(fp: string): Promise<StrategyProfile | null> {
    const rows = await this.db.select().from(strategyProfile).where(eq(strategyProfile.sourceFingerprint, fp)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }
}
