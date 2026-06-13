import { describe, it, expect } from 'vitest';
import { agentIdForType, lifecycleForType, AGENT_IDS, KNOWN_AGENT_IDS } from './agent-taxonomy.ts';

describe('agentIdForType (ordered, separator-tolerant)', () => {
  it('routes builder events, including the underscore form', () => {
    expect(agentIdForType('build.started')).toBe('builder');
    expect(agentIdForType('build_failed')).toBe('builder');         // underscore, not dot
    expect(agentIdForType('builder.completed')).toBe('builder');
    expect(agentIdForType('artifact.stored')).toBe('builder');
    expect(agentIdForType('backtest.submitted')).toBe('builder');
    expect(agentIdForType('evaluation.completed')).toBe('builder');
    expect(agentIdForType('hypothesis.build.started')).toBe('builder'); // specific-first guard
  });
  it('routes researcher events without swallowing build', () => {
    expect(agentIdForType('research.run_cycle.started')).toBe('researcher');
    expect(agentIdForType('researcher.completed')).toBe('researcher');
    expect(agentIdForType('hypothesis.validated')).toBe('researcher');
    expect(agentIdForType('hypothesis.rejected')).toBe('researcher');
    expect(agentIdForType('hypothesis.deduped')).toBe('researcher');
    expect(agentIdForType('hypothesis.generated')).toBe('researcher');
  });
  it('routes analyst + critic', () => {
    expect(agentIdForType('strategy_analyst.started')).toBe('analyst');
    expect(agentIdForType('strategy.onboard.deduped')).toBe('analyst');
    expect(agentIdForType('critic.reviewed')).toBe('critic');
  });
  it('falls unknown types back to system, never researcher', () => {
    expect(agentIdForType('chat.message.received')).toBe('system');
    expect(agentIdForType('totally.unknown')).toBe('system');
  });
});

describe('lifecycleForType (failure-first)', () => {
  it('maps suffixes', () => {
    expect(lifecycleForType('researcher.started')).toBe('working');
    expect(lifecycleForType('research.run_cycle.completed')).toBe('succeeded');
    expect(lifecycleForType('hypothesis.validated')).toBe('succeeded');
    expect(lifecycleForType('hypothesis.deduped')).toBe('succeeded');
    expect(lifecycleForType('critic.failed')).toBe('failed');
    expect(lifecycleForType('hypothesis.rejected')).toBe('failed');
    expect(lifecycleForType('build_failed')).toBe('failed');           // underscore terminal
  });
  it('defaults unknown mid-workflow suffixes to working', () => {
    expect(lifecycleForType('backtest.submitted')).toBe('working');
    expect(lifecycleForType('artifact.stored')).toBe('working');
  });
});

describe('id constants', () => {
  it('exposes four known agents + system', () => {
    expect(KNOWN_AGENT_IDS).toEqual(['analyst', 'researcher', 'critic', 'builder']);
    expect(AGENT_IDS).toEqual(['analyst', 'researcher', 'critic', 'builder', 'system']);
  });
});
