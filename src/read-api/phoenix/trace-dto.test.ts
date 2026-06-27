import { describe, it, expect } from 'vitest';
import { buildTracesFromSpans, type RawPhoenixSpan } from './trace-dto.ts';

const span = (o: Partial<RawPhoenixSpan> & { trace_id: string; span_id: string }): RawPhoenixSpan => ({
  name: 'x', span_kind: 'CHAIN', parent_id: null,
  start_time: '2026-06-27T10:00:00.000Z', end_time: '2026-06-27T10:00:01.000Z',
  status_code: 'OK', attributes: {},
  context: { trace_id: o.trace_id, span_id: o.span_id },
  ...o,
});

describe('buildTracesFromSpans', () => {
  it('groups spans by trace, keeps only traces whose root AGENT span matches, and nests spans', () => {
    const raw: RawPhoenixSpan[] = [
      span({ trace_id: 't1', span_id: 'a', name: 'strategy-analyst', span_kind: 'AGENT' }),
      span({ trace_id: 't1', span_id: 'b', parent_id: 'a', name: 'gpt', span_kind: 'LLM',
        attributes: { 'llm.model_name': 'claude', 'llm.token_count.prompt': 10, 'llm.token_count.completion': 5, 'llm.token_count.total': 15 } }),
      span({ trace_id: 't2', span_id: 'c', name: 'researcher', span_kind: 'AGENT' }), // different agent, filtered out
    ];
    const out = buildTracesFromSpans(raw, (root) => root.name === 'strategy-analyst');
    expect(out).toHaveLength(1);
    expect(out[0]!.traceId).toBe('t1');
    expect(out[0]!.rootName).toBe('strategy-analyst');
    expect(out[0]!.latencyMs).toBe(1000);
    expect(out[0]!.tokens).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(out[0]!.spans.map((s) => s.spanId)).toEqual(['a', 'b']);
    const llm = out[0]!.spans.find((s) => s.kind === 'LLM')!;
    expect(llm.llm).toEqual({ model: 'claude', tokensIn: 10, tokensOut: 5 });
  });

  it('marks a trace as error when any span has status_code ERROR', () => {
    const raw: RawPhoenixSpan[] = [
      span({ trace_id: 't1', span_id: 'a', name: 'builder', span_kind: 'AGENT' }),
      span({ trace_id: 't1', span_id: 'b', parent_id: 'a', name: 'tool', span_kind: 'TOOL', status_code: 'ERROR' }),
    ];
    expect(buildTracesFromSpans(raw, () => true)[0]!.status).toBe('error');
  });
});
