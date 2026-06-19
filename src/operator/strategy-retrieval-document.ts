import { createHash } from 'node:crypto';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { StrategyRetrievalDocument, StrategyRetrievalMetadata } from '../domain/strategy-retrieval.ts';

/**
 * Build the canonical retrieval text for a strategy profile.
 * Sections appear in a FIXED order (direction → core idea → summary →
 * required market features → entry conditions → exit conditions →
 * risk management → position management → parameters → unknowns).
 * Sections whose backing field is empty/null are omitted entirely.
 * This fixed-order construction makes the text (and its hash) stable
 * regardless of the JS object-key order of the incoming profile.
 */
export function buildStrategyRetrievalText(profile: StrategyProfile): string {
  const p = profile.profile;
  const lines: string[] = [];

  const add = (label: string, value: string | null | undefined): void => {
    if (value && value.trim().length > 0) lines.push(`${label}: ${value.trim()}`);
  };

  const addList = (label: string, items: readonly string[] | null | undefined): void => {
    if (items && items.length > 0) lines.push(`${label}: ${items.join('; ')}`);
  };

  // Fixed section order
  add('direction', p.direction);
  add('core idea', p.coreIdea);
  add('summary', p.summary);
  addList('required market features', p.requiredMarketFeatures);
  addList('entry conditions', p.entryConditions);
  addList('exit conditions', p.exitConditions);
  add('risk management', p.riskManagementSummary);
  add('position management', p.positionManagementSummary);

  if (p.parameters && p.parameters.length > 0) {
    const paramText = p.parameters
      .map((param) => `${param.name}=${String(param.value)}${param.unit ? param.unit : ''}`)
      .join('; ');
    lines.push(`parameters: ${paramText}`);
  }

  addList('unknowns', p.unknowns);

  return lines.join('\n');
}

/**
 * Deterministic SHA-256 hash of the canonical retrieval text.
 * Prefixed with "sha256:" to match the repo's fingerprint convention.
 */
function hashContent(text: string): string {
  const hex = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

export interface BuildDocumentOptions {
  embedding: readonly number[];
  embeddingModel: string;
  indexVersion: number;
  indexedAt: string;
}

/**
 * Assemble a StrategyRetrievalDocument from a profile and embedding.
 * contentHash is derived from the canonical text so it is stable across
 * object-key-order permutations and changes when any labelled field changes.
 */
export function buildStrategyRetrievalDocument(
  profile: StrategyProfile,
  opts: BuildDocumentOptions,
): StrategyRetrievalDocument {
  const content = buildStrategyRetrievalText(profile);
  const contentHash = hashContent(content);

  const metadata: StrategyRetrievalMetadata = {};
  // Only carry non-'unknown' direction to avoid polluting filters with noise
  if (profile.direction !== 'unknown') {
    metadata.direction = profile.direction as 'long' | 'short' | 'both';
  }
  if (profile.version !== undefined) metadata.profileVersion = profile.version;
  if (profile.createdAt) metadata.createdAt = profile.createdAt;

  return {
    strategyProfileId: profile.id,
    content,
    contentHash,
    embedding: opts.embedding,
    embeddingModel: opts.embeddingModel,
    indexVersion: opts.indexVersion,
    metadata,
    indexedAt: opts.indexedAt,
  };
}
