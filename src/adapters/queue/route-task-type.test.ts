import { describe, it, expect } from 'vitest';
import { routeTaskType } from './route-task-type.ts';
import { AGENT_TASK_TYPES } from '../../domain/schemas.ts';

describe('routeTaskType', () => {
  it('routes revision.* to the revision lane', () => {
    expect(routeTaskType('revision.build')).toBe('revision');
    expect(routeTaskType('revision.consolidate')).toBe('revision');
  });

  it('routes everything else to the default lane', () => {
    expect(routeTaskType('hypothesis.build')).toBe('default');
    expect(routeTaskType('backtest.completed')).toBe('default');
    expect(routeTaskType('paper.monitor')).toBe('default');
  });

  it('routes an unknown task type to the default lane', () => {
    expect(routeTaskType('totally.unknown')).toBe('default');
    expect(routeTaskType('')).toBe('default');
  });

  it('maps every registered AgentTaskType to a lane (exhaustive)', () => {
    for (const t of AGENT_TASK_TYPES) {
      const lane = routeTaskType(t);
      expect(lane === 'default' || lane === 'revision').toBe(true);
      if (t.startsWith('revision.')) expect(lane).toBe('revision');
      else expect(lane).toBe('default');
    }
  });
});
