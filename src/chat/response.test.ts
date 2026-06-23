import { describe, it, expect } from 'vitest';
import {
  outOfScope, help, capabilityNotAvailable, needsClarification,
  taskCreated, taskStatus, rejected, errorResponse,
} from './response.ts';

describe('ChatResponse builders', () => {
  it('out_of_scope carries the sessionId and a static message', () => {
    const r = outOfScope('s1');
    expect(r.kind).toBe('out_of_scope');
    expect(r.sessionId).toBe('s1');
    expect(r.message.length).toBeGreaterThan(0);
  });

  it('help lists the supported intents', () => {
    const r = help('s1');
    expect(r.kind).toBe('help');
    expect(r.supportedIntents).toEqual(['strategy.onboard', 'research.run_cycle', 'hypothesis.build', 'task.status', 'help', 'out_of_scope']);
  });

  it('capability_not_available names the capability', () => {
    const r = capabilityNotAvailable('s1', 'results.trading', 'not yet');
    expect(r.kind).toBe('capability_not_available');
    expect(r.capability).toBe('results.trading');
  });

  it('needs_clarification carries the question and missing fields', () => {
    const r = needsClarification('s1', 'which task?', ['taskId']);
    expect(r.kind).toBe('needs_clarification');
    expect(r.missing).toEqual(['taskId']);
  });

  it('task_created carries ids and an optional planned next step', () => {
    const r = taskCreated('s1', 't1', 'strategy.onboard', 'queued', { taskType: 'research.run_cycle', after: 'strategy.onboard' });
    expect(r.kind).toBe('task_created');
    expect(r.taskId).toBe('t1');
    expect(r.plannedNextStep?.taskType).toBe('research.run_cycle');
  });

  it('task_status, rejected, error carry their fields', () => {
    expect(taskStatus('s1', 't1', 'running').status).toBe('running');
    expect(rejected('s1', 'low_confidence').reason).toBe('low_confidence');
    expect(errorResponse('s1', 'boom').message).toBe('boom');
  });
});
