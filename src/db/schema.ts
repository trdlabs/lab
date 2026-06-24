import { pgTable, text, jsonb, timestamp, index, uniqueIndex, integer, real, boolean, doublePrecision, vector, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnalystProfileOutput } from '../domain/strategy-profile.ts';
import type { ArtifactRef, TaskSource } from '../domain/types.ts';
import type { RuleAction, ExpectedEffect, HypothesisProposalDraft } from '../domain/hypothesis.ts';
import type { ValidationIssue } from '../domain/schemas.ts';
import type { CriticConcern } from '../domain/critic.ts';
import type { ModuleManifest } from '../domain/module-bundle.ts';
import type { BacktestMetricBlock, ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { EvaluatorThresholds } from '../validation/evaluator.ts';
import type { ActionProposalStatus, ProposedTaskSnapshot, OperatorAction } from '../domain/action-proposal.ts';
import type { PendingOperatorInteraction } from '../ports/chat-session.repository.ts';
import type { EvidenceRef, StrategyRetrievalMetadata } from '../domain/strategy-retrieval.ts';

// Postgres tsvector has no first-class Drizzle column type. This customType lets us
// DECLARE the column so drizzle-kit tracks it; the GENERATED ALWAYS expression that
// fills it from `content` is added by hand in migration 0010 (drizzle-kit cannot
// emit a tsvector generated-column expression for a customType).
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

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

export const researchTokenUsage = pgTable('research_token_usage', {
  correlationId: text('correlation_id').primaryKey(),
  cumulativeTokens: integer('cumulative_tokens').notNull().default(0),
  cumulativeCostUsd: doublePrecision('cumulative_cost_usd').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  createdIdx: index('agent_event_created_idx').on(t.createdAt, t.id),
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

export const hypothesisProposal = pgTable('hypothesis_proposal', {
  id: text('id').primaryKey(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  thesis: text('thesis').notNull(),
  targetBehavior: text('target_behavior').notNull(),
  ruleAction: jsonb('rule_action').notNull().$type<RuleAction>(),
  requiredFeatures: jsonb('required_features').notNull().$type<string[]>(),
  validationPlan: text('validation_plan').notNull(),
  expectedEffect: jsonb('expected_effect').notNull().$type<ExpectedEffect>(),
  invalidationCriteria: jsonb('invalidation_criteria').notNull().$type<string[]>(),
  confidence: real('confidence').notNull(),
  status: text('status').notNull(),
  fingerprint: text('fingerprint').notNull(),
  proposal: jsonb('proposal').notNull().$type<HypothesisProposalDraft>(),
  issues: jsonb('issues').notNull().$type<ValidationIssue[]>(),
  contractVersion: text('contract_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Per-profile exact-dedupe guard at the DB level. The handler skips known fingerprints
  // before insert, so this is a race backstop, never the primary dedupe path.
  profileFpUq: uniqueIndex('hypothesis_proposal_profile_fp_uq').on(t.strategyProfileId, t.fingerprint),
  profileIdx: index('hypothesis_proposal_profile_idx').on(t.strategyProfileId),
  statusIdx: index('hypothesis_proposal_status_idx').on(t.status),
  createdIdx: index('hypothesis_proposal_created_idx').on(t.createdAt, t.id),
}));

export const hypothesisReview = pgTable('hypothesis_review', {
  id: text('id').primaryKey(),
  hypothesisId: text('hypothesis_id').notNull(),
  criticAdapter: text('critic_adapter').notNull(),
  criticModel: text('critic_model').notNull(),
  verdict: text('verdict').notNull(),
  concerns: jsonb('concerns').notNull().$type<CriticConcern[]>(),
  summary: text('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // No FK to hypothesis_proposal by design — review is an append-only audit row.
  hypothesisIdx: index('hypothesis_review_hypothesis_idx').on(t.hypothesisId),
}));

export const hypothesisBuild = pgTable('hypothesis_build', {
  id: text('id').primaryKey(),
  hypothesisId: text('hypothesis_id').notNull(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  status: text('status').notNull(),
  builderAdapter: text('builder_adapter').notNull(),
  builderModel: text('builder_model').notNull(),
  bundleHash: text('bundle_hash'),
  bundleArtifactRef: jsonb('bundle_artifact_ref').$type<ArtifactRef>(),
  manifest: jsonb('manifest').$type<ModuleManifest>(),
  sdkContractVersion: text('sdk_contract_version').notNull(),
  bundleContractVersion: text('bundle_contract_version').notNull(),
  issues: jsonb('issues').notNull().$type<ValidationIssue[]>(),
  attempt: integer('attempt').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  hypothesisIdx: index('hypothesis_build_hypothesis_idx').on(t.hypothesisId),
  statusIdx: index('hypothesis_build_status_idx').on(t.status),
}));

export const backtestRun = pgTable('backtest_run', {
  id: text('id').primaryKey(),
  hypothesisBuildId: text('hypothesis_build_id').notNull(),
  hypothesisId: text('hypothesis_id').notNull(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  platformRunId: text('platform_run_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  params: jsonb('params').notNull().$type<Record<string, unknown>>(),
  paramsHash: text('params_hash').notNull(),
  bundleHash: text('bundle_hash').notNull(),
  status: text('status').notNull(),
  baselineModuleId: text('baseline_module_id').notNull(),
  variantModuleId: text('variant_module_id').notNull(),
  backend: text('backend').notNull().default('sp4_mock'),
  taskId: text('task_id'),
  resumeToken: text('resume_token'),
  platformRun: jsonb('platform_run').$type<PlatformRunConfig>(),
  netPnlUsd: doublePrecision('net_pnl_usd'),
  netPnlPct: doublePrecision('net_pnl_pct'),
  totalTrades: integer('total_trades'),
  winRate: doublePrecision('win_rate'),
  profitFactor: doublePrecision('profit_factor'),
  maxDrawdownPct: doublePrecision('max_drawdown_pct'),
  expectancyUsd: doublePrecision('expectancy_usd'),
  sharpe: doublePrecision('sharpe'),
  topTradeContributionPct: doublePrecision('top_trade_contribution_pct'),
  isFragile: boolean('is_fragile'),
  baselineMetrics: jsonb('baseline_metrics').$type<BacktestMetricBlock>(),
  deltaNetPnlUsd: doublePrecision('delta_net_pnl_usd'),
  deltaMaxDrawdownPct: doublePrecision('delta_max_drawdown_pct'),
  artifactRefs: jsonb('artifact_refs').notNull().$type<string[]>(),
  platformContractVersion: text('platform_contract_version').notNull(),
  sdkContractVersion: text('sdk_contract_version').notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idemUq: uniqueIndex('backtest_run_idem_uq').on(t.hypothesisId, t.paramsHash, t.bundleHash),
  hypothesisIdx: index('backtest_run_hypothesis_idx').on(t.hypothesisId),
  statusIdx: index('backtest_run_status_idx').on(t.status),
  createdIdx: index('backtest_run_created_idx').on(t.createdAt, t.id),
}));

export const evaluation = pgTable('evaluation', {
  id: text('id').primaryKey(),
  backtestRunId: text('backtest_run_id').notNull(),
  hypothesisId: text('hypothesis_id').notNull(),
  decision: text('decision').notNull(),
  reasons: jsonb('reasons').notNull().$type<string[]>(),
  metricsSnapshot: jsonb('metrics_snapshot').notNull().$type<ComparisonSummary>(),
  thresholds: jsonb('thresholds').notNull().$type<EvaluatorThresholds>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  backtestRunIdx: index('evaluation_backtest_run_idx').on(t.backtestRunId),
}));

export const chatSession = pgTable('chat_session', {
  sessionId: text('session_id').primaryKey(),
  lastStrategyProfileId: text('last_strategy_profile_id'),
  lastResearchTaskId: text('last_research_task_id'),
  lastHypothesisId: text('last_hypothesis_id'),
  lastBacktestRunId: text('last_backtest_run_id'),
  lastUserGoal: text('last_user_goal'),
  pendingPlanId: text('pending_plan_id'),
  pendingInteraction: jsonb('pending_interaction').$type<PendingOperatorInteraction>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chatPlan = pgTable('chat_plan', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  afterTaskId: text('after_task_id').notNull(),
  nextTaskType: text('next_task_type').notNull(),
  resolveProfileByFingerprint: text('resolve_profile_by_fingerprint').notNull(),
  correlationId: text('correlation_id').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Powers the worker hook query: findPendingByAfterTaskId(afterTaskId).
  afterStatusIdx: index('chat_plan_after_task_status_idx').on(t.afterTaskId, t.status),
  sessionIdx: index('chat_plan_session_idx').on(t.sessionId),
}));

export const actionProposal = pgTable('action_proposal', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  subjectHash: text('subject_hash').notNull(),
  action: text('action').notNull().$type<OperatorAction>(),
  source: text('source').notNull().$type<TaskSource>(),
  task: jsonb('task').notNull().$type<ProposedTaskSnapshot>(),
  status: text('status').notNull().$type<ActionProposalStatus>(),
  evidenceRefs: jsonb('evidence_refs').notNull().default(sql`'[]'::jsonb`).$type<EvidenceRef[]>(),
  evidenceWarnings: jsonb('evidence_warnings').notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
  confirmedTaskId: text('confirmed_task_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionStatusIdx: index('action_proposal_session_status_idx').on(t.sessionId, t.status),
}));

// Rebuildable retrieval projection for Operator strategy lookup. One row per strategy
// profile; embeddings are 1024-dim (baai/bge-m3). `search_vector` is a STORED generated
// column derived from `content` via to_tsvector('simple', ...). The (index_version,
// embedding_model) pair lets the indexer rebuild on model/version bumps and lets readers
// exclude stale projections. Never stores raw secrets; `content` is the canonical,
// already-redacted projection text.
export const strategyRetrievalDocument = pgTable('strategy_retrieval_document', {
  strategyProfileId: text('strategy_profile_id').primaryKey(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  embedding: vector('embedding', { dimensions: 1024 }),
  // Declared so drizzle-kit tracks the column; the GENERATED ALWAYS expression is
  // (re)asserted by hand in migration 0010. Kept aligned here so future generates do
  // not see drift.
  searchVector: tsvector('search_vector').generatedAlwaysAs(sql`to_tsvector('simple', "content")`),
  embeddingModel: text('embedding_model').notNull(),
  indexVersion: integer('index_version').notNull(),
  metadata: jsonb('metadata').notNull().$type<StrategyRetrievalMetadata>(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  searchVectorGin: index('strategy_retrieval_document_search_vector_gin').using('gin', t.searchVector),
  embeddingHnsw: index('strategy_retrieval_document_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
  versionModelIdx: index('strategy_retrieval_document_version_model_idx').on(t.indexVersion, t.embeddingModel),
}));
