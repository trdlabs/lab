import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { EmbeddingPort } from '../ports/embedding.port.ts';
import type { StrategyRetrievalIndexPort } from '../ports/strategy-retrieval-index.port.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import { buildStrategyRetrievalText, buildStrategyRetrievalDocument } from './strategy-retrieval-document.ts';

export interface IndexerConfig {
  embeddingModel: string;
  indexVersion: number;
}

export interface ReindexSummary {
  indexed: number;
  skipped: number;
  failed: number;
}

type IndexResult = 'indexed' | 'failed';

/**
 * StrategyRetrievalIndexer builds retrieval projections for strategy profiles.
 *
 * Fail-soft: index() NEVER throws — embedding or upsert failures emit
 * retrieval.strategy_index_failed and return normally so that the calling
 * onboarding flow is not interrupted.
 */
export class StrategyRetrievalIndexer {
  private readonly embedding: EmbeddingPort;
  private readonly indexPort: StrategyRetrievalIndexPort;
  private readonly config: IndexerConfig;
  private readonly clock: () => string;
  private readonly events: AgentEventRepository;

  constructor(
    embedding: EmbeddingPort,
    indexPort: StrategyRetrievalIndexPort,
    config: IndexerConfig,
    clock: () => string,
    events: AgentEventRepository,
  ) {
    this.embedding = embedding;
    this.indexPort = indexPort;
    this.config = config;
    this.clock = clock;
    this.events = events;
  }

  /**
   * Index a single profile. Fail-soft: never throws.
   * On success  → emits retrieval.strategy_indexed (ids/hash/model/version only).
   * On failure  → emits retrieval.strategy_index_failed (profileId + reasonCode).
   * Returns the outcome so reindex() can tally results without re-running.
   */
  async index(profile: StrategyProfile): Promise<void> {
    await this._indexInternal(profile);
  }

  private async _indexInternal(profile: StrategyProfile): Promise<IndexResult> {
    const now = this.clock();
    const text = buildStrategyRetrievalText(profile);

    let embeddingVec: readonly number[];
    try {
      const results = await this.embedding.embed([text]);
      const vec: readonly number[] | undefined = results[0];

      if (!vec || vec.length !== this.embedding.dimensions) {
        await this.events.append({
          id: randomUUID(),
          taskId: profile.id,
          type: 'retrieval.strategy_index_failed',
          payload: {
            profileId: profile.id,
            reasonCode: 'dimension_mismatch',
            expected: this.embedding.dimensions,
            got: vec ? vec.length : 0,
          },
          createdAt: now,
        });
        return 'failed';
      }
      embeddingVec = vec;
    } catch (err) {
      await this.events.append({
        id: randomUUID(),
        taskId: profile.id,
        type: 'retrieval.strategy_index_failed',
        payload: {
          profileId: profile.id,
          reasonCode: 'embed_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        createdAt: now,
      });
      return 'failed';
    }

    const doc = buildStrategyRetrievalDocument(profile, {
      embedding: embeddingVec,
      embeddingModel: this.config.embeddingModel,
      indexVersion: this.config.indexVersion,
      indexedAt: now,
    });

    try {
      await this.indexPort.upsert(doc);
    } catch (err) {
      await this.events.append({
        id: randomUUID(),
        taskId: profile.id,
        type: 'retrieval.strategy_index_failed',
        payload: {
          profileId: profile.id,
          reasonCode: 'upsert_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        createdAt: now,
      });
      return 'failed';
    }

    // Success: emit event with ids/hash/model/version only — NO content, NO embedding
    await this.events.append({
      id: randomUUID(),
      taskId: profile.id,
      type: 'retrieval.strategy_indexed',
      payload: {
        profileId: profile.id,
        contentHash: doc.contentHash,
        embeddingModel: this.config.embeddingModel,
        indexVersion: this.config.indexVersion,
        indexedAt: now,
      },
      createdAt: now,
    });
    return 'indexed';
  }

  /**
   * Repair/reindex a list of profiles.
   * Skips profiles whose existing projection has a matching contentHash AND
   * the current embeddingModel and indexVersion.
   * Reindexes stale projections (hash mismatch or model/version bump).
   * Never throws — failures are counted in the summary.
   */
  async reindex(profiles: readonly StrategyProfile[]): Promise<ReindexSummary> {
    let indexed = 0;
    let skipped = 0;
    let failed = 0;

    for (const profile of profiles) {
      const text = buildStrategyRetrievalText(profile);
      const expectedHash = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

      // Check existing projection
      let existing = null;
      try {
        existing = await this.indexPort.findByProfileId(profile.id);
      } catch {
        // If we can't check, treat as missing and attempt to index
      }

      if (existing !== null) {
        const hashCurrent = existing.contentHash === expectedHash;
        const modelCurrent = existing.embeddingModel === this.config.embeddingModel;
        const versionCurrent = existing.indexVersion === this.config.indexVersion;

        if (hashCurrent && modelCurrent && versionCurrent) {
          skipped++;
          continue;
        }
      }

      // Need to index (new or stale)
      const result = await this._indexInternal(profile);
      if (result === 'indexed') {
        indexed++;
      } else {
        failed++;
      }
    }

    return { indexed, skipped, failed };
  }
}
