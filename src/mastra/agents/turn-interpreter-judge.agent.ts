// src/mastra/agents/turn-interpreter-judge.agent.ts
// Judge agent for the TurnInterpreter eval harness. Lives in src/mastra (single home for Agent
// construction). Separate from the production turn-interpreter agent — it assesses, never interprets.
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const TURN_INTERPRETER_JUDGE_AGENT_ID = 'turn-interpreter-judge';

const INSTRUCTIONS = [
  'You are evaluating a parsed InterpretedTurn produced by a turn-interpreter model against the original operator message.',
  'Score each dimension from 0 to 1 with a short rationale: constraint faithfulness (no fabricated market/symbol/timeframe/direction not in the message), subject accuracy, goal accuracy, and strategyText capture (how well the strategyText field captures the strategy content in the message).',
  'List any constraints or references in the parsed output NOT supported by the original message (hallucinations).',
  'List expected fields from the message that are missing from the parsed output (missingFromExpected).',
  'Be strict and concise. Do not propose changes; only assess.',
].join(' ');

export function createTurnInterpreterJudgeAgent(model: ProviderModel): Agent {
  return new Agent({ id: TURN_INTERPRETER_JUDGE_AGENT_ID, name: 'Turn Interpreter Judge', instructions: INSTRUCTIONS, model });
}
