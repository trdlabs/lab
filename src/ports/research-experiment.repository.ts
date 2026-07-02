import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation,
} from '../domain/research-experiment.ts';

export interface ResearchExperimentRepository {
  createExperiment(e: ResearchExperiment): Promise<void>;
  findById(id: string): Promise<ResearchExperiment | null>;
  findByKey(experimentKey: string): Promise<ResearchExperiment | null>;
  updateExperiment(id: string, patch: Partial<Pick<ResearchExperiment,
    'status' | 'verdict' | 'verdictReason' | 'holdoutBoundary' | 'aggregateMetrics' | 'completedAt' | 'updatedAt' | 'parameterGrid'>>): Promise<void>;
  addMember(m: ExperimentRunMember): Promise<void>;
  updateMember(id: string, patch: Partial<Pick<ExperimentRunMember,
    'backtestRunId' | 'strategyBacktestRunId' | 'tradeCount' | 'resultSummary'>>): Promise<void>;
  listMembers(experimentId: string): Promise<ExperimentRunMember[]>;
  addEvaluation(ev: ExperimentEvaluation): Promise<void>;
}
