import { pgTable, text, jsonb, timestamp, index, uniqueIndex, integer, real } from 'drizzle-orm/pg-core';
import type { AnalystProfileOutput } from '../domain/strategy-profile.ts';
import type { ArtifactRef } from '../domain/types.ts';

export const researchTask = pgTable('research_task', {
  id: text('id').primaryKey(),
  taskType: text('task_type').notNull(),
  source: text('source').notNull(),
  correlationId: text('correlation_id').notNull(),
  dedupeKey: text('dedupe_key'),
  status: text('status').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // UNIQUE index: DB-level dedupe guard against races. Postgres treats multiple
  // NULLs as distinct, so tasks without a dedupeKey never collide.
  dedupeIdx: uniqueIndex('research_task_dedupe_key_uq').on(t.dedupeKey),
  corrIdx: index('research_task_correlation_idx').on(t.correlationId),
}));

export const agentEvent = pgTable('agent_event', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // No FK from task_id -> research_task.id by design: agent_event is an append-only
  // event log and must accept events even if the parent row is archived/removed.
  taskIdx: index('agent_event_task_idx').on(t.taskId),
}));

export const strategyProfile = pgTable('strategy_profile', {
  id: text('id').primaryKey(),
  version: integer('version').notNull().default(1),
  sourceKind: text('source_kind').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  direction: text('direction').notNull(),
  coreIdea: text('core_idea').notNull(),
  requiredMarketFeatures: jsonb('required_market_features').notNull().$type<string[]>(),
  confidence: real('confidence').notNull(),
  unknowns: jsonb('unknowns').notNull().$type<string[]>(),
  profile: jsonb('profile').notNull().$type<AnalystProfileOutput>(),
  sourceArtifactRef: jsonb('source_artifact_ref').notNull().$type<ArtifactRef>(),
  contractVersion: text('contract_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fingerprintUq: uniqueIndex('strategy_profile_fingerprint_uq').on(t.sourceFingerprint),
  kindIdx: index('strategy_profile_source_kind_idx').on(t.sourceKind),
}));
