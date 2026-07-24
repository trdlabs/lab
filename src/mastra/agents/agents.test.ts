// src/mastra/agents/agents.test.ts
import { describe, it, expect } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createStrategyAnalystAgent, STRATEGY_ANALYST_AGENT_ID } from './strategy-analyst.agent.ts';
import { createResearcherAgent, RESEARCHER_AGENT_ID } from './researcher.agent.ts';
import { createCriticAgent, CRITIC_AGENT_ID } from './critic.agent.ts';
import { createBuilderAgent, BUILDER_AGENT_ID } from './builder.agent.ts';
import { createTurnInterpreterAgent, TURN_INTERPRETER_AGENT_ID } from './turn-interpreter.agent.ts';
import {
  createSweepDesignerAgent, SWEEP_DESIGNER_AGENT_ID, SWEEP_DESIGNER_INSTRUCTIONS,
} from './sweep-designer.agent.ts';
import { SWEEP_AXIS_CATALOG_PROMPT } from '../../research/sweep-axis-catalog.ts';

const model = createAnthropic({ apiKey: 'dummy' })('claude-sonnet-4-6');

describe('mastra agent factories', () => {
  it('build agents with the expected id and name', () => {
    const cases = [
      [createStrategyAnalystAgent(model), STRATEGY_ANALYST_AGENT_ID, 'Strategy Analyst'],
      [createResearcherAgent(model), RESEARCHER_AGENT_ID, 'Researcher'],
      [createCriticAgent(model), CRITIC_AGENT_ID, 'Critic'],
      [createBuilderAgent(model), BUILDER_AGENT_ID, 'Builder'],
      [createTurnInterpreterAgent(model), TURN_INTERPRETER_AGENT_ID, 'Turn Interpreter'],
      [createSweepDesignerAgent(model), SWEEP_DESIGNER_AGENT_ID, 'SweepDesigner'],
    ] as const;
    expect(cases).toHaveLength(6);
    for (const [agent, id, name] of cases) {
      expect(agent.id).toBe(id);
      expect(agent.name).toBe(name);
    }
  });
});

// R13 (research-validation-hardening item 6, report-13 G13): sweep-designer must carry the
// deterministic axis catalog (hold time / entry thresholds / stops-takes / cooldown / sizing /
// regime-as-axis), the "wide plateau, not a peak" + "degradation point" rules, and the leverage
// denylist — pinned the same way RESEARCHER_INSTRUCTIONS pins RESEARCHER_CAPABILITIES.
describe('SWEEP_DESIGNER_INSTRUCTIONS', () => {
  it('embeds the axis catalog verbatim', () => {
    expect(SWEEP_DESIGNER_INSTRUCTIONS).toContain(SWEEP_AXIS_CATALOG_PROMPT);
  });

  it('carries the plateau-not-peak and degradation-point rules', () => {
    expect(SWEEP_DESIGNER_INSTRUCTIONS).toMatch(/wide plateau, not (a )?peak/i);
    expect(SWEEP_DESIGNER_INSTRUCTIONS).toMatch(/degradation point/i);
  });

  it('carries the leverage denylist', () => {
    expect(SWEEP_DESIGNER_INSTRUCTIONS).toMatch(/leverage/i);
    expect(SWEEP_DESIGNER_INSTRUCTIONS).toMatch(/liquidation/i);
  });
});
