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
