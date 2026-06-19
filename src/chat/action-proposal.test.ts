import { describe, it, expect } from 'vitest';
import { buildActionProposal } from './action-proposal.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';

describe('buildActionProposal', () => {
  it('strategy.analyze case: trims message, sets dedupeKey, carries snapshot fields', () => {
    const built = buildActionProposal({
      id: 'p1',
      sessionId: 's1',
      source: 'web',
      message: '  Лонг после пролива  ',
      decision: {
        kind: 'propose_task',
        action: 'strategy.analyze',
        taskType: 'strategy.onboard',
        payload: { kind: 'manual_description', content: 'Лонг после пролива' },
        userGoal: 'strategy.onboard',
      },
      now: '2026-06-18T12:00:00.000Z',
      expiresAt: '2026-06-18T12:10:00.000Z',
    });

    expect(built.subjectHash).toBe(sourceFingerprint('manual_description', 'Лонг после пролива'));
    expect(built.task.dedupeKey).toBe('chat-proposal:p1');
    expect(built.action).toBe('strategy.analyze');
    expect(built.status).toBe('pending');
    expect(built.source).toBe('web');
    expect(built.task.taskType).toBe('strategy.onboard');
    expect(built.task.userGoal).toBe('strategy.onboard');
    expect(built.createdAt).toBe('2026-06-18T12:00:00.000Z');
    expect(built.updatedAt).toBe('2026-06-18T12:00:00.000Z');
    expect(built.expiresAt).toBe('2026-06-18T12:10:00.000Z');
    expect(built.id).toBe('p1');
    expect(built.sessionId).toBe('s1');
    expect(built.task.chain).toBeUndefined();
  });

  it('research.run_cycle with chain: carries chain through to task snapshot', () => {
    const built = buildActionProposal({
      id: 'p2',
      sessionId: 's2',
      source: 'web',
      message: 'go long on oi spike',
      decision: {
        kind: 'propose_task',
        action: 'research.run_cycle',
        taskType: 'strategy.onboard',
        payload: { kind: 'manual_description', content: 'go long on oi spike' },
        chain: { nextTaskType: 'research.run_cycle', resolveProfileByFingerprint: 'sha256:abc' },
        userGoal: 'strategy.onboard',
      },
      now: '2026-06-18T13:00:00.000Z',
      expiresAt: '2026-06-18T13:10:00.000Z',
    });

    expect(built.action).toBe('research.run_cycle');
    expect(built.task.chain?.nextTaskType).toBe('research.run_cycle');
    expect(built.task.chain?.resolveProfileByFingerprint).toBe('sha256:abc');
    expect(built.task.dedupeKey).toBe('chat-proposal:p2');
    expect(built.status).toBe('pending');
  });

  it('hypothesis.build: action and taskType match, no chain', () => {
    const built = buildActionProposal({
      id: 'p3',
      sessionId: 's3',
      source: 'web',
      message: 'build hypothesis',
      decision: {
        kind: 'propose_task',
        action: 'hypothesis.build',
        taskType: 'hypothesis.build',
        payload: { hypothesisId: 'h1', cycleDepth: 0 },
        userGoal: 'hypothesis.build',
      },
      now: '2026-06-18T14:00:00.000Z',
      expiresAt: '2026-06-18T14:10:00.000Z',
    });

    expect(built.action).toBe('hypothesis.build');
    expect(built.task.taskType).toBe('hypothesis.build');
    expect(built.task.chain).toBeUndefined();
    expect(built.task.dedupeKey).toBe('chat-proposal:p3');
  });

  it('dedupeKey from decision is replaced by chat-proposal:<id>', () => {
    const built = buildActionProposal({
      id: 'p4',
      sessionId: 's4',
      source: 'operator',
      message: 'some message',
      decision: {
        kind: 'propose_task',
        action: 'strategy.analyze',
        taskType: 'strategy.onboard',
        payload: { kind: 'manual_description', content: 'some message' },
        dedupeKey: 'old-key-that-should-be-replaced',
        userGoal: 'strategy.onboard',
      },
      now: '2026-06-18T15:00:00.000Z',
      expiresAt: '2026-06-18T15:10:00.000Z',
    });

    expect(built.task.dedupeKey).toBe('chat-proposal:p4');
  });
});
