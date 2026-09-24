// The ring/strip render avatars at ~40-46px CSS but x.md stores the profile
// image's `_normal` (48px) variant, which is visibly soft on a retina
// display (QA report A17). `_bigger` (or `_400x400`) is the same Twitter/X
// image at a larger size behind the same filename, so this is a pure string
// rewrite with no extra request or fallback needed — post-card avatars are
// left at `_normal` since they render smaller and weren't reported as soft.
// Kept out of App.tsx (a component file) so this plain export doesn't trip
// react-doctor's only-export-components rule, same reasoning as
// src/sortOptions.ts.
export function ringAvatarUrl(url: string | undefined): string | undefined {
  return url?.replace(/_normal(\.[a-z]+)(\?.*)?$/i, "_bigger$1$2");
}
