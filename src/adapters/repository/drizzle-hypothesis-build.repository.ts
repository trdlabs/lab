// src/adapters/repository/drizzle-hypothesis-build.repository.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { hypothesisBuild } from '../../db/schema.ts';
import type { HypothesisBuild, HypothesisBuildStatus } from '../../domain/hypothesis-build.ts';
import type { ModuleManifest } from '../../domain/module-bundle.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { HypothesisBuildRepository } from '../../ports/hypothesis-build.repository.ts';

type Row = typeof hypothesisBuild.$inferSelect;

function toDomain(row: Row): HypothesisBuild {
  return {
    id: row.id, hypothesisId: row.hypothesisId, strategyProfileId: row.strategyProfileId,
    status: row.status as HypothesisBuildStatus, builderAdapter: row.builderAdapter, builderModel: row.builderModel,
    bundleHash: row.bundleHash, bundleArtifactRef: (row.bundleArtifactRef as ArtifactRef | null) ?? null,
    manifest: (row.manifest as ModuleManifest | null) ?? null,
    sdkContractVersion: row.sdkContractVersion, bundleContractVersion: row.bundleContractVersion,
    issues: row.issues as ValidationIssue[], attempt: row.attempt,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleHypothesisBuildRepository implements HypothesisBuildRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async createGenerating(b: HypothesisBuild): Promise<void> {
    await this.db.insert(hypothesisBuild).values({
      id: b.id, hypothesisId: b.hypothesisId, strategyProfileId: b.strategyProfileId, status: b.status,
      builderAdapter: b.builderAdapter, builderModel: b.builderModel, bundleHash: b.bundleHash,
      bundleArtifactRef: b.bundleArtifactRef, manifest: b.manifest, sdkContractVersion: b.sdkContractVersion,
      bundleContractVersion: b.bundleContractVersion, issues: b.issues, attempt: b.attempt,
      createdAt: new Date(b.createdAt), updatedAt: new Date(b.updatedAt),
    });
  }

  async markBuildFailed(id: string, issues: ValidationIssue[]): Promise<void> {
    await this.db.update(hypothesisBuild).set({ status: 'build_failed', issues, updatedAt: new Date() }).where(eq(hypothesisBuild.id, id));
  }

  async markCandidate(id: string, fields: { bundleHash: string; bundleArtifactRef: ArtifactRef; manifest: ModuleManifest }): Promise<void> {
    await this.db.update(hypothesisBuild).set({ status: 'candidate', bundleHash: fields.bundleHash, bundleArtifactRef: fields.bundleArtifactRef, manifest: fields.manifest, updatedAt: new Date() }).where(eq(hypothesisBuild.id, id));
  }

  async markSubmitted(id: string): Promise<void> {
    await this.db.update(hypothesisBuild).set({ status: 'submitted', updatedAt: new Date() }).where(eq(hypothesisBuild.id, id));
  }

  async findById(id: string): Promise<HypothesisBuild | null> {
    const rows = await this.db.select().from(hypothesisBuild).where(eq(hypothesisBuild.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async listByHypothesis(hypothesisId: string): Promise<HypothesisBuild[]> {
    const rows = await this.db.select().from(hypothesisBuild).where(eq(hypothesisBuild.hypothesisId, hypothesisId));
    return rows.map(toDomain);
  }
}
