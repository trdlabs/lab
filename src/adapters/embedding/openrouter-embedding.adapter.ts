import type { EmbeddingPort } from '../../ports/embedding.port.ts';

const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
const SUPPORTED_DIMENSIONS = 1024;

interface EmbeddingItem {
  object: string;
  index: number;
  embedding: number[];
}

interface EmbeddingResponse {
  object: string;
  data: EmbeddingItem[];
  model: string;
}

export class OpenRouterEmbeddingAdapter implements EmbeddingPort {
  readonly dimensions = SUPPORTED_DIMENSIONS;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(model: string, apiKey: string, fetchFn: typeof fetch = fetch) {
    this.model = model;
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]> {
    const response = await this.fetchFn(OPENROUTER_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal,
    });

    if (!response.ok) {
      // Sanitize: never include raw provider body, API key, or request text in the error
      throw new Error(
        `Upstream embedding request failed with HTTP ${response.status}. Check OPENROUTER_API_KEY and model availability.`,
      );
    }

    let parsed: EmbeddingResponse;
    try {
      parsed = (await response.json()) as EmbeddingResponse;
    } catch {
      throw new Error('Upstream embedding response was not valid JSON.');
    }

    const items = parsed.data;
    if (!Array.isArray(items) || items.length !== texts.length) {
      throw new Error(
        `Upstream returned ${items?.length ?? 0} embedding(s) but ${texts.length} input(s) were sent.`,
      );
    }

    // Re-order by index to guarantee input-order output (spec: ordered batch output)
    const ordered = new Array<number[]>(texts.length);
    for (const item of items) {
      const idx = item.index;
      if (idx < 0 || idx >= texts.length) {
        throw new Error(`Upstream returned an out-of-range embedding index: ${idx}.`);
      }
      const vec = item.embedding;
      if (!Array.isArray(vec) || vec.length !== SUPPORTED_DIMENSIONS) {
        throw new Error(
          `Dimension mismatch: expected ${SUPPORTED_DIMENSIONS}-dimensional vector but got ${vec?.length ?? 0} at index ${idx}.`,
        );
      }
      for (const v of vec) {
        if (!Number.isFinite(v)) {
          throw new Error(`Non-finite value in embedding at index ${idx}.`);
        }
      }
      ordered[idx] = vec;
    }

    return ordered;
  }
}
