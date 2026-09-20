import { ConvexError } from "convex/values";
import type { SummaryScope } from "./contracts";

export type Sort = "relevance" | "engagement" | "likes" | "newest" | "oldest";
export function parseQuery(raw: string) {
  if (raw.length > 300) throw new Error("Keep searches under 300 characters.");
  const authors = [...raw.matchAll(/(?:^|\s)(?:from:)?@([A-Za-z0-9_]{1,15})(?=\s|$)/g)].map((m) =>
    m[1].toLowerCase(),
  );
  if (new Set(authors).size > 1)
    throw new Error("Search one author at a time, or remove the @ filters to search everyone.");
  const text = raw
    .replace(/(?:^|\s)(?:from:)?@[A-Za-z0-9_]{1,15}(?=\s|$)/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (/(?:^|\s)-?(?!https?:\/\/)[a-z_][a-z0-9_]*:/i.test(text))
    throw new Error(
      "Use @handle to filter authors. Other X operators are available through Find on X.",
    );
  return { text, author: authors[0] };
}

// --- Authorized collection scope ---------------------------------------------
// The search wire contract (docs/integration-contract.md) has no per-user or
// per-collection scoping field, and `accounts` (convex/schema.ts) carries no
// owner/membership column: every indexed account is one shared, global
// corpus across all authenticated app users today. `SummaryScope`
// (convex/lib/contracts.ts) already reserves a narrower `{ kind: "account",
// accountId }` shape for later, but per docs/publication-contract.md
// ("Explicitly out of scope here"), nothing computes or enforces it yet —
// building real per-account authorization needs an agreed ownership/
// membership model with Pronsh first (collection memberships, scoped
// tombstones).
//
// `assertAuthorizedScope` is the fail-closed gate for that gap: a caller
// never gets to assert its own scope. Anything other than the one scope this
// app can currently authorize is rejected outright rather than silently
// downgraded to "global" or silently honored as if enforcement existed.
export function assertAuthorizedScope(scope: SummaryScope | undefined): void {
  if (scope && scope.kind !== "global") {
    throw new ConvexError("This search scope is not available yet.");
  }
}

// --- Stale search cursor ------------------------------------------------------
// The Rust API maps StaleCursor to HTTP 409 Conflict. Keep cursors opaque:
// only interpret this status as expired pagination when a cursor was sent.
export const STALE_CURSOR_STATUS = 409;
export class StaleSearchCursorError extends Error {
  constructor() {
    super("The search cursor is no longer valid.");
    this.name = "StaleSearchCursorError";
  }
}
