// src/orchestrator/handlers/research-run-cycle.test-fixtures.ts
// Shared test fixtures for research-run-cycle.handler.test.ts and its siblings
// (pure extraction, no behavior change).
import type { HypothesisProposalDraft, ResearcherOutput } from '../../domain/hypothesis.ts';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';

export function draft(thesis: string, action: 'skip_entry' | 'no_op' = 'skip_entry', bars = 1): HypothesisProposalDraft {
  return {
    thesis, targetBehavior: 'filter entries',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend', action, params: { bars } }] },
    requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['no improvement'], confidence: 0.5,
  };
}

export function stubResearcher(out: ResearcherOutput): ResearcherPort {
  return { adapter: 'fake', model: 'stub', async propose(_in: ResearcherInput) { return out; } };
}
