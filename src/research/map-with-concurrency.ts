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
        const p = fn(items[i] as T, i);
        // Attach a rejection observer immediately, at call time — before
        // awaiting — so `failed` is set by the FIRST handler queued for
        // this promise (rather than only via the try/catch below, which
        // would attach its reaction later).
        p.then(undefined, (err: unknown) => {
          if (!failed) {
            failed = true;
            firstError = err;
          }
        });
        results[i] = await p;
        // Yield one more microtask turn before re-checking `failed`. This closes the
        // same-microtask-drain race: when a sibling lane's item rejects in the SAME
        // microtask drain as this lane's item resolves, the rejection is already queued
        // ahead of this lane's post-await continuation, so the extra tick lets that
        // same-drain rejection observer run first and this lane sees the up-to-date
        // `failed`. This is best-effort beyond same-drain, though: a rejection that
        // settles later (a different drain) can still let one extra item start before
        // `failed` is observed — operationally absorbed by idempotent resumeToken
        // replays. See the pinning test 'fail-fast under concurrency: no new item
        // starts after a rejection settles (limit=2)'.
        await Promise.resolve();
      } catch (err) {
        // Covers both a synchronous throw from `fn` and `p` rejecting.
        // The observer above may have already recorded `firstError`; this
        // is a harmless no-op in that case.
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
