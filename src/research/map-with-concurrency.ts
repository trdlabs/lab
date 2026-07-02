/** Bounded parallel map: results keep input order; fail-fast — after the first
 *  rejection no new items start, in-flight items settle, the first error rethrows.
 *  limit=1 is exactly a serial for-await loop. */
export function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;

  const lane = async (): Promise<void> => {
    while (!failed) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  };

  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => lane());
  return Promise.all(lanes).then(() => {
    if (failed) throw firstError;
    return results;
  });
}
