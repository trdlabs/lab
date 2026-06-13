// Pure derivation of a logical agent id + lifecycle status from an agent_event.type.
// Matching is ordered (first rule wins) and separator-tolerant: a prefix P matches T
// iff T === P or T starts with P + '.' or P + '_'. The underscore case is load-bearing —
// the build handler emits `build_failed`, which a dotted-only `build.` rule would miss.

export type AgentId = 'analyst' | 'researcher' | 'critic' | 'builder' | 'system';
export type AgentLifecycle = 'idle' | 'working' | 'succeeded' | 'failed';

export const KNOWN_AGENT_IDS = ['analyst', 'researcher', 'critic', 'builder'] as const;
export const AGENT_IDS = [...KNOWN_AGENT_IDS, 'system'] as const;

function matches(type: string, prefix: string): boolean {
  return type === prefix || type.startsWith(`${prefix}.`) || type.startsWith(`${prefix}_`);
}

// Ordered, specific-first. `hypothesis.build` precedes the concrete researcher events.
const RULES: ReadonlyArray<{ prefixes: readonly string[]; agentId: Exclude<AgentId, 'system'> }> = [
  { prefixes: ['hypothesis.build'], agentId: 'builder' },
  { prefixes: ['build', 'builder', 'artifact', 'backtest', 'evaluation'], agentId: 'builder' },
  {
    prefixes: [
      'research.run_cycle', 'researcher',
      'hypothesis.generated', 'hypothesis.validated', 'hypothesis.rejected', 'hypothesis.deduped',
    ],
    agentId: 'researcher',
  },
  { prefixes: ['strategy_analyst', 'strategy.onboard'], agentId: 'analyst' },
  { prefixes: ['critic'], agentId: 'critic' },
];

export function agentIdForType(type: string): AgentId {
  for (const rule of RULES) {
    if (rule.prefixes.some((p) => matches(type, p))) return rule.agentId;
  }
  return 'system';
}

const FAILED = new Set(['failed', 'rejected', 'error']);
const WORKING = new Set(['started', 'running']);
const SUCCEEDED = new Set(['completed', 'validated', 'reviewed', 'deduped', 'skipped']);

// A single event always implies one of working|succeeded|failed; `idle` is a projection-level
// (no-events) state, never returned here. Failure is checked first so a type carrying both
// tokens cannot be misclassified.
export function lifecycleForType(type: string): Exclude<AgentLifecycle, 'idle'> {
  const last = type.toLowerCase().split(/[._]/).pop() ?? '';
  if (FAILED.has(last)) return 'failed';
  if (WORKING.has(last)) return 'working';
  if (SUCCEEDED.has(last)) return 'succeeded';
  return 'working'; // unknown mid-workflow suffix (e.g. submitted, stored, reused)
}
