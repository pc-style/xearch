import { ConvexError } from "convex/values";
import type { SummaryScope } from "./contracts";

export type Sort = "relevance" | "engagement" | "likes" | "newest" | "oldest";

// Three spellings of one author filter: `@theo`, `from:@theo` and `from:theo`.
// The bare `from:handle` form was previously NOT recognised as an author — it
// fell through to the operator check below and was rejected as an unsupported
// operator, even though the "find on X" button (src/ResultsSection.tsx) generated exactly
// that spelling. All three now normalise to the same lowercased handle.
// Built fresh per call rather than shared as one module-level /g regex: a
// global regex carries `lastIndex` between uses, and this pattern is used
// twice per parse (matchAll, then replace).
const authorFilter = () => /(?:^|\s)(?:from:@?|@)([A-Za-z0-9_]{1,15})(?=\s|$)/g;

export function parseQuery(raw: string) {
  if (raw.length > 300) throw new Error("Keep searches under 300 characters.");
  const authors = [...raw.matchAll(authorFilter())].map((m) => m[1].toLowerCase());

  if (new Set(authors).size > 1)
    throw new Error("Search one author at a time, or remove the @ filters to search everyone.");
  const text = raw.replace(authorFilter(), " ").trim().replace(/\s+/g, " ");

  if (/(?:^|\s)-?(?!https?:\/\/)[a-z_][a-z0-9_]*:/i.test(text))
    throw new Error(
      "Use @handle to filter authors. Other X operators are available through Find on X.",
    );

  return { text, author: authors[0] };
}

/**
 * One spelling for one search. `@theo`, `from:@theo` and `from:theo` all
 * parse to the same author, so they must also STORE the same way — otherwise
 * the same search opens three differently-named rows and each one slips past
 * the duplicate guard, which matches on the stored string.
 *
 * Rendering lives here next to the parsing it inverts, so the two cannot
 * drift: `convex/jobs.ts` canonicalises what a person typed, and
 * `convex/integrations.ts` re-renders what the model proposed, and both get
 * the same answer.
 */
export function canonicalQuery(raw: string): { text: string; author?: string; canonical: string } {
  const { text, author } = parseQuery(raw.trim());

  return { text, author, canonical: [author ? `@${author}` : "", text].filter(Boolean).join(" ") };
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
