import * as z from "zod/mini";
import { resultPost } from "./results";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

const count = z.int().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER));

/**
 * Wire contract of the private semantic API (search/semantic/README.md),
 * read only as far as the app uses it. It has no total and no cursor: a
 * semantic page is the nearest posts, not a count of matches.
 */
export const semanticResponse = z.object({
  hits: z.array(z.object({ post: resultPost, score: z.number() })).check(z.maxLength(20)),
  coverage: z.object({
    posts: count,
    pending: count,
    // Captures by status. Anything other than "complete" is posts the
    // index has not read yet: discovered, failed, or mid-export.
    captures: z.record(z.string().check(z.maxLength(40)), count),
  }),
});

function plural(n: number, word: string) {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The rows `search.complete` stores, plus a warning whenever the semantic
 * index is still catching up, so a partial index never reads as a
 * complete answer.
 */
export function decodeSemanticResponse(input: Json) {
  const { hits, coverage } = semanticResponse.parse(input);

  const unread = Object.entries(coverage.captures)
    .filter(([status]) => status !== "complete")
    .reduce((sum, [, n]) => sum + n, 0);

  const warnings: string[] = [];

  if (coverage.pending > 0 || unread > 0) {
    const parts = [
      coverage.pending > 0 ? `${plural(coverage.pending, "post")} still being embedded` : "",
      unread > 0 ? `${plural(unread, "capture")} not read yet` : "",
    ].filter(Boolean);

    warnings.push(
      `Semantic search is still indexing (${parts.join(", ")}), so some matching posts may be missing.`,
    );
  }

  return { rows: hits.map((hit) => hit.post), warnings };
}
