import type { Sort } from "../convex/lib/search";

// Shared between the sort <select> and the Saved searches modal (both in
// App.tsx), so a saved query's sort always reads back with the exact label
// the picker showed when it was saved. Kept out of App.tsx itself so this
// plain export doesn't trip react-doctor's only-export-components rule for
// component files.
export const sorts: { value: Sort; label: string }[] = [
  { value: "relevance", label: "Relevant" },
  { value: "engagement", label: "Relevant + engagement" },
  { value: "likes", label: "Most liked" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];

export function sortLabel(sort: Sort): string {
  return sorts.find((s) => s.value === sort)?.label ?? sort;
}

/**
 * Whether `raw`+`sort` is already in the saved list. `convex/search.ts:save`
 * stores and compares the *trimmed* query, so a restored URL with stray
 * whitespace in `raw` has to be trimmed here too — otherwise an
 * already-saved search reads as not-saved and "Save search" stays enabled
 * (CodeRabbit finding on PR #46).
 */
export function isAlreadySaved(
  saved: readonly { query: string; sort: Sort }[],
  raw: string,
  sort: Sort,
): boolean {
  const trimmed = raw.trim();

  return saved.some((s) => s.query === trimmed && s.sort === sort);
}

/**
 * What changing the sort <select> should do, given the draft box and the
 * currently active query. Picking a query to re-search on is deliberately
 * *not* "whichever one is non-empty": if the draft has an uncommitted edit,
 * that's what the user is about to search; if the draft was cleared but a
 * previous search's results are still on screen (keyed off `raw`, not
 * `draft`), that active query is what "resort these" has to mean, or
 * `result` and `sort` state end up mismatched and the results view gets
 * stuck on "Finding matching posts…" forever (CodeRabbit finding on PR #46
 * — setting `sort` alone left nothing to reconcile it with `result`).
 * Neither exists only at the true empty-home state, where there's nothing
 * to re-search and nothing on screen to desync.
 */
export function sortChangeQuery(draft: string, raw: string): string | null {
  if (draft.trim()) return draft;

  if (raw) return raw;

  return null;
}
