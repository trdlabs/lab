// Thin HTTP client for the Ops Read Surface A (ops.3) — the trading-platform read surface the mock
// also serves. Mirrors the BacktesterClient split: raw fetch lives here (FetchLike-injectable for
// tests); the adapter is a thin port-implementing bridge. The SDK /ops-read is types-only, so this
// client encodes Surface A's wire contract (paths/envelope/auth) itself.

export interface FetchLikeInit { method?: string; headers?: Record<string, string>; }
export interface FetchLikeResponse { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; }
export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface OpsReadClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Defaults to the global fetch. */
  readonly fetchImpl?: FetchLike;
}

/** Surface A read error in lab's vocabulary (status + ops error code). */
export class OpsReadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(`ops-read ${status}/${code}: ${message}`);
    this.name = 'OpsReadError';
    this.status = status;
    this.code = code;
  }
}

export class OpsReadClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpsReadClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`; // omit when open (loopback)
    const res = await this.fetchImpl(`${this.base}${path}`, { method: 'GET', headers });
    if (res.ok) return (await res.json()) as T;

    let payload: { code?: string; message?: string } | undefined;
    try { payload = (await res.json()) as typeof payload; } catch { payload = undefined; }
    throw new OpsReadError(res.status, payload?.code ?? 'error', payload?.message ?? `ops-read responded ${res.status} for ${path}`);
  }
}
