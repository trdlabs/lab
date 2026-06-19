import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterEmbeddingAdapter } from './openrouter-embedding.adapter.ts';

const TEST_MODEL = 'baai/bge-m3';
const TEST_KEY = 'sk-or-test-key';
const DIMENSIONS = 1024;

function makeVector(value = 0.1): number[] {
  return Array.from({ length: DIMENSIONS }, () => value);
}

function makeSuccessResponse(inputs: string[], ordered = true): Response {
  const data = inputs.map((_, i) => ({
    object: 'embedding',
    index: ordered ? i : inputs.length - 1 - i,
    embedding: makeVector(0.1 + i * 0.01),
  }));
  return new Response(
    JSON.stringify({ object: 'list', data, model: TEST_MODEL }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('OpenRouterEmbeddingAdapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let adapter: OpenRouterEmbeddingAdapter;

  beforeEach(() => {
    fetchMock = vi.fn();
    adapter = new OpenRouterEmbeddingAdapter(TEST_MODEL, TEST_KEY, fetchMock as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes model and dimensions', () => {
    expect(adapter.model).toBe(TEST_MODEL);
    expect(adapter.dimensions).toBe(DIMENSIONS);
  });

  it('POSTs to the correct OpenRouter endpoint', async () => {
    fetchMock.mockResolvedValueOnce(makeSuccessResponse(['hello']));
    await adapter.embed(['hello']);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');
  });

  it('sends Authorization: Bearer header with the API key', async () => {
    fetchMock.mockResolvedValueOnce(makeSuccessResponse(['hello']));
    await adapter.embed(['hello']);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TEST_KEY}`);
  });

  it('sends the requested model in the request body', async () => {
    fetchMock.mockResolvedValueOnce(makeSuccessResponse(['hello']));
    await adapter.embed(['hello']);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe(TEST_MODEL);
  });

  it('returns embeddings in original input order (unordered response)', async () => {
    const inputs = ['first', 'second', 'third'];
    // response items come back in reverse order
    const data = inputs.map((_, i) => ({
      object: 'embedding',
      index: inputs.length - 1 - i,
      embedding: makeVector(0.1 + (inputs.length - 1 - i) * 0.01),
    }));
    const resp = new Response(
      JSON.stringify({ object: 'list', data, model: TEST_MODEL }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    fetchMock.mockResolvedValueOnce(resp);
    const result = await adapter.embed(inputs);
    // index 0 should be at position 0, regardless of response order
    expect(result[0]).toEqual(makeVector(0.1 + 0 * 0.01));
    expect(result[1]).toEqual(makeVector(0.1 + 1 * 0.01));
    expect(result[2]).toEqual(makeVector(0.1 + 2 * 0.01));
  });

  it('forwards the AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce(makeSuccessResponse(['hello']));
    const controller = new AbortController();
    await adapter.embed(['hello'], controller.signal);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('throws a sanitized error on non-2xx — no raw body or key in message', async () => {
    const errorBody = JSON.stringify({ error: { message: 'invalid key sk-or-test-key' } });
    const makeErrorResponse = (): Response =>
      new Response(errorBody, {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });

    // First call: just verifies it throws
    fetchMock.mockResolvedValueOnce(makeErrorResponse());
    await expect(adapter.embed(['hello'])).rejects.toThrow();

    // Second call: verify no key or raw provider message leaks
    fetchMock.mockResolvedValueOnce(makeErrorResponse());
    let err: Error;
    try {
      await adapter.embed(['hello']);
      throw new Error('Expected embed to throw');
    } catch (e: unknown) {
      err = e as Error;
    }
    expect(err.message).not.toContain(TEST_KEY);
    expect(err.message).not.toContain('invalid key');
    // Must mention HTTP status or upstream so caller can diagnose
    expect(err.message.includes('401') || err.message.toLowerCase().includes('upstream')).toBe(true);
  });

  it('rejects when response vector length != 1024', async () => {
    const data = [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }];
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'list', data, model: TEST_MODEL }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(adapter.embed(['hello'])).rejects.toThrow(/dimension/i);
  });

  it('rejects when response item count != input count', async () => {
    // Only 1 item returned for 2 inputs
    const data = [{ object: 'embedding', index: 0, embedding: makeVector() }];
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'list', data, model: TEST_MODEL }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(adapter.embed(['first', 'second'])).rejects.toThrow();
  });

  it('rejects when embedding contains non-finite values', async () => {
    const embedding = makeVector();
    embedding[0] = Infinity;
    const data = [{ object: 'embedding', index: 0, embedding }];
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'list', data, model: TEST_MODEL }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(adapter.embed(['hello'])).rejects.toThrow();
  });
});
