import * as z from "zod/mini";

/**
 * A JSON-serializable value — what `JSON.parse`/`response.json()` produce, plus
 * `undefined` object properties so object-literal test fixtures that omit an
 * optional field (inferred by TypeScript as `?: undefined`) satisfy it too.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

// zod/mini rather than zod: every search query loads this module, and the
// full `zod` namespace is ~450KB of bundle the Convex isolate has to parse on
// a cold start. The mini build tree-shakes down to the checks used here.
const safeLink = z.string().check(
  z.refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }),
);

const metric = z.number().check(z.gte(0));

const pixels = z.int().check(z.gt(0), z.lte(100_000));

const media = z.object({
  kind: z.enum(["photo", "video", "gif"]),
  image: safeLink,
  video: z.optional(safeLink),
  width: z.optional(pixels),
  height: z.optional(pixels),
  alt: z.optional(z.string().check(z.maxLength(1000))),
});

const card = z.object({
  url: safeLink,
  title: z.string().check(z.maxLength(300)),
  description: z.optional(z.string().check(z.maxLength(500))),
  domain: z.optional(z.string().check(z.maxLength(253))),
  image: z.optional(safeLink),
});

const quote = z.object({
  url: safeLink,
  author: z.string().check(z.regex(/^[A-Za-z0-9_]{1,15}$/)),
  displayName: z.optional(z.string().check(z.maxLength(100))),
  text: z.string().check(z.maxLength(2000)),
  createdAt: z.optional(z.number()),
  image: z.optional(safeLink),
});

/** Wire contract for the external indexer/search service, not a corpus model. */
export const resultPost = z.object({
  tweetId: z.string().check(z.regex(/^\d+$/)),
  author: z.string().check(z.regex(/^[A-Za-z0-9_]{1,15}$/)),
  text: z.string().check(z.maxLength(6000)),
  url: safeLink,
  createdAt: z.optional(z.number()),
  likes: z.optional(metric),
  reposts: z.optional(metric),
  replies: z.optional(metric),
  links: z.array(safeLink).check(z.maxLength(10)),
  avatar: z.optional(safeLink),
  displayName: z.optional(z.string().check(z.maxLength(100))),
  replyTo: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_]{1,15}$/))),
  media: z.optional(z.array(media).check(z.maxLength(4))),
  card: z.optional(card),
  quote: z.optional(quote),
});

export type ResultPost = z.infer<typeof resultPost>;

const stat = z.int().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER));

const backendStats = z.object({
  totalUs: stat,
  reloadUs: stat,
  fingerprintUs: stat,
  cursorUs: stat,
  compileUs: stat,
  retrieveUs: stat,
  rankingCalls: stat,
  materializeUs: stat,
  candidateHits: stat,
  returnedRows: stat,
  indexDocs: stat,
  segments: stat,
});

const apiStats = z.object({
  totalUs: stat,
  authUs: stat,
  validateUs: stat,
  cursorVerifyUs: stat,
  parseUs: stat,
  permitUs: stat,
  queueUs: stat,
  engineUs: stat,
  postprocessUs: stat,
  cursorSignUs: stat,
});

export const searchStats = z.object({
  backend: backendStats,
  api: z.optional(apiStats),
});

export const searchResponse = z.object({
  rows: z.array(resultPost).check(z.maxLength(20)),
  total: z.optional(stat),
  nextCursor: z.optional(z.string().check(z.maxLength(4000))),
  stats: z.optional(searchStats),
  warnings: z.optional(z.array(z.string().check(z.maxLength(500))).check(z.maxLength(10))),
});

export function decodeSearchResponse(input: Json) {
  const result = searchResponse.parse(input);

  return { ...result, warnings: result.warnings ?? [] };
}
