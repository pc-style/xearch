import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { requireOperator } from "./access";
import { postFields } from "./schema";
import { attemptSearch, RETRYABLE_FAILURE_KINDS, type SearchRequestBody } from "./search";
import { parseQuery } from "./lib/search";
import { serviceToken } from "./lib/serviceAuth";
import type { ResultPost } from "./lib/results";
import {
  decodeSystemOne,
  intentRequest,
  MAX_CANDIDATES,
  pickRequest,
  readIntent,
  readPick,
  readScore,
  scoreRequest,
  TYPESAFE_URL,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./lib/jev";

// Operator-only (/pc-jev on the operator site). Neither action writes to
// the database: candidates and rankings go straight back to the caller.

function parsed(raw: string) {
  if (!raw.trim()) throw new ConvexError("Enter a search.");

  try {
    return parseQuery(raw);
  } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : "Invalid search.");
  }
}

/** Up to `MAX_CANDIDATES` posts in the search service's relevance order. */
export const candidates = action({
  args: { raw: v.string(), operatorToken: v.optional(v.string()) },
  returns: v.object({
    rows: v.array(v.object(postFields)),
    total: v.optional(v.number()),
    warnings: v.array(v.string()),
  }),
  handler: async (ctx, { raw, operatorToken }) => {
    await requireOperator(ctx, operatorToken);
    const query = parsed(raw);
    const url = process.env.SEARCH_API_URL;

    if (!url) throw new ConvexError("The search service is not connected (SEARCH_API_URL).");
    const baseHeaders = { "Content-Type": "application/json" } satisfies Record<string, string>;
    const token = serviceToken("search");
    const headers = token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders;

    const rows: ResultPost[] = [];
    let total: number | undefined;
    let warnings: string[] = [];
    let cursor: string | undefined;

    // Pages of 20, the size the decoder accepts (convex/lib/results.ts).
    do {
      const body: SearchRequestBody = {
        version: 1,
        query: query.text,
        author: query.author,
        sort: "relevance",
        cursor,
        limit: 20,
      };

      let attempt = await attemptSearch(url, headers, body, cursor !== undefined);

      if (attempt.kind === "failed" && RETRYABLE_FAILURE_KINDS.has(attempt.failure.kind))
        attempt = await attemptSearch(url, headers, body, cursor !== undefined);

      if (attempt.kind === "failed") {
        // A later page failing still leaves a usable candidate set.
        if (rows.length) break;
        throw new ConvexError(`The search service failed (${attempt.failure.kind}). Try again.`);
      }

      rows.push(...attempt.result.rows);
      total ??= attempt.result.total;
      warnings = attempt.result.warnings;
      cursor = attempt.result.nextCursor;
    } while (cursor && rows.length < MAX_CANDIDATES);

    return { rows: rows.slice(0, MAX_CANDIDATES), total, warnings };
  },
});

async function systemOne(apiKey: string, request: SystemOneRequest): Promise<SystemOneResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    // Honor TypeSafe's own rate limit once (docs.typesafe.ai/models "Rate limits").
    const retryAfter = Number(response.headers.get("retry-after"));

    if (response.status === 429 && attempt === 0 && retryAfter > 0 && retryAfter <= 5) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);

      throw new ConvexError(
        `TypeSafe returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }

    try {
      return decodeSystemOne(await response.json());
    } catch {
      throw new ConvexError("TypeSafe returned a response this app could not read.");
    }
  }
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await run();

  return { value, ms: Date.now() - started };
}

/** Jev's intent guess, then both rankings of `posts` for it. */
export const rank = action({
  args: {
    raw: v.string(),
    posts: v.array(
      v.object({
        tweetId: v.string(),
        author: v.string(),
        text: v.string(),
        likes: v.optional(v.number()),
        createdAt: v.optional(v.number()),
        links: v.array(v.string()),
      }),
    ),
    operatorToken: v.optional(v.string()),
  },
  returns: v.object({
    intent: v.object({ key: v.string(), label: v.string(), confidence: v.number() }),
    // One number per input post, in input order.
    pick: v.array(v.number()),
    score: v.array(v.number()),
    ms: v.object({ intent: v.number(), rank: v.number(), total: v.number() }),
    inputTokens: v.number(),
  }),
  handler: async (ctx, { raw, posts, operatorToken }) => {
    await requireOperator(ctx, operatorToken);
    const query = parsed(raw).text.trim() || raw.trim();

    if (!posts.length) throw new ConvexError("Search first, then ask Jev.");

    if (posts.length > MAX_CANDIDATES)
      throw new ConvexError(`Jev ranks at most ${MAX_CANDIDATES} posts.`);
    const apiKey = process.env.TYPESAFE_API_KEY;

    if (!apiKey) throw new ConvexError("Add TYPESAFE_API_KEY to this deployment to use Jev.");
    const now = Date.now();

    const intentStep = await timed(() => systemOne(apiKey, intentRequest(query)));
    let intent;

    try {
      intent = readIntent(intentStep.value);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "No intent.");
    }

    const rankStep = await timed(() =>
      Promise.all([
        systemOne(apiKey, pickRequest(query, intent.key, posts, now)),
        systemOne(apiKey, scoreRequest(query, intent.key, posts, now)),
      ]),
    );

    const [pickResponse, scoreResponse] = rankStep.value;
    let pick: number[];
    let score: number[];

    try {
      pick = readPick(pickResponse, posts.length);
      score = readScore(scoreResponse, posts.length);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Incomplete ranking.");
    }

    return {
      intent,
      pick,
      score,
      ms: { intent: intentStep.ms, rank: rankStep.ms, total: Date.now() - now },
      inputTokens: [intentStep.value, pickResponse, scoreResponse].reduce(
        (sum, response) => sum + response.usage.input_tokens,
        0,
      ),
    };
  },
});
