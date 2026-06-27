export type TraceReasonCode = 'tracing-disabled' | 'phoenix-unreachable' | 'no-traces';
export type SpanKind = 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN';

export interface RawPhoenixSpan {
  name: string;
  span_kind: string;
  parent_id: string | null;
  start_time: string;
  end_time: string;
  status_code: string;
  attributes: Record<string, unknown>;
  context: { trace_id: string; span_id: string };
}

export interface SpanDto {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startTime: string;
  latencyMs: number;
  status: 'ok' | 'error';
  llm?: { model?: string; tokensIn?: number; tokensOut?: number };
}

export interface TraceDto {
  traceId: string;
  startTime: string;
  status: 'ok' | 'error';
  latencyMs: number;
  tokens?: { prompt?: number; completion?: number; total?: number };
  costUsd?: number | null;
  rootName: string;
  spans: SpanDto[];
}

export interface AgentTracesDto {
  agentId: string;
  reasonCode: TraceReasonCode | null;
  traces: TraceDto[];
}

const KINDS: SpanKind[] = ['AGENT', 'LLM', 'TOOL', 'CHAIN'];
const toKind = (s: RawPhoenixSpan): SpanKind => {
  const raw = String(s.span_kind ?? s.attributes['openinference.span.kind'] ?? 'CHAIN').toUpperCase();
  return (KINDS as string[]).includes(raw) ? (raw as SpanKind) : 'CHAIN';
};
const ms = (start: string, end: string): number => Math.max(0, Date.parse(end) - Date.parse(start));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isError = (s: RawPhoenixSpan): boolean => String(s.status_code).toUpperCase() === 'ERROR';

function toSpanDto(s: RawPhoenixSpan): SpanDto {
  const kind = toKind(s);
  const tokensIn = num(s.attributes['llm.token_count.prompt']);
  const tokensOut = num(s.attributes['llm.token_count.completion']);
  const model = s.attributes['llm.model_name'];
  const llm =
    kind === 'LLM' ? { model: typeof model === 'string' ? model : undefined, tokensIn, tokensOut } : undefined;
  return {
    spanId: s.context.span_id,
    parentSpanId: s.parent_id ?? null,
    name: s.name,
    kind,
    startTime: s.start_time,
    latencyMs: ms(s.start_time, s.end_time),
    status: isError(s) ? 'error' : 'ok',
    ...(llm ? { llm } : {}),
  };
}

export function buildTracesFromSpans(
  rawSpans: RawPhoenixSpan[],
  matchAgent: (root: RawPhoenixSpan) => boolean,
): TraceDto[] {
  const byTrace = new Map<string, RawPhoenixSpan[]>();
  for (const s of rawSpans) {
    const id = s.context.trace_id;
    (byTrace.get(id) ?? byTrace.set(id, []).get(id)!).push(s);
  }
  const traces: TraceDto[] = [];
  for (const [traceId, spans] of byTrace) {
    const root = spans.find((s) => s.parent_id == null && toKind(s) === 'AGENT')
      ?? spans.find((s) => toKind(s) === 'AGENT');
    if (!root || !matchAgent(root)) continue;
    const ordered = [...spans].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
    const totalPrompt = ordered.reduce((n, s) => n + (num(s.attributes['llm.token_count.prompt']) ?? 0), 0);
    const totalCompletion = ordered.reduce((n, s) => n + (num(s.attributes['llm.token_count.completion']) ?? 0), 0);
    traces.push({
      traceId,
      startTime: root.start_time,
      status: ordered.some(isError) ? 'error' : 'ok',
      latencyMs: ms(root.start_time, root.end_time),
      tokens: { prompt: totalPrompt, completion: totalCompletion, total: totalPrompt + totalCompletion },
      costUsd: null,
      rootName: root.name,
      spans: ordered.map(toSpanDto),
    });
  }
  return traces.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
}
