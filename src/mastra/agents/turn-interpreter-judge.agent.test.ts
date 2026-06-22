// src/mastra/agents/turn-interpreter-judge.agent.test.ts
import { describe, it, expect } from 'vitest';
import { createTurnInterpreterJudgeAgent, TURN_INTERPRETER_JUDGE_AGENT_ID } from './turn-interpreter-judge.agent.ts';

describe('createTurnInterpreterJudgeAgent', () => {
  it('builds an agent with the judge id and no tools', async () => {
    const fakeModel = {} as never;
    const agent = createTurnInterpreterJudgeAgent(fakeModel);
    expect(agent).toBeDefined();
    expect(agent.id).toBe(TURN_INTERPRETER_JUDGE_AGENT_ID);
    expect(agent.name).toBe('Turn Interpreter Judge');
    expect(await agent.getInstructions()).toBeTruthy();
    expect(await agent.listTools()).toEqual({});
  });
});
