export interface RingSplit<T> {
  shown: T[];
  overflow: number;
}

/**
 * Split a list into what fits in a fixed-size ring and how many were left
 * out, reserving one ring slot for a "+N more" chip when the list is over
 * capacity. Kept generic and pure (no React) so the off-by-one CodeRabbit
 * caught on PR #46 — the chip undercounted by one, computing overflow as
 * `items.length - limit` instead of from the actual slice shown — has a
 * regression test that doesn't need to render the ring itself.
 */
export function splitRing<T>(items: readonly T[], limit: number): RingSplit<T> {
  const shown = items.length > limit ? items.slice(0, limit - 1) : items.slice(0, limit);

  // Count from the two lengths, not from `limit` directly: when the ring is
  // over capacity, `shown` itself is `limit - 1` long (one slot reserved for
  // the "+N" chip), so `items.length - limit` understated how many items the
  // ring actually omits by one.
  return { shown, overflow: items.length - shown.length };
}
