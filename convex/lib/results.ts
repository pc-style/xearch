import * as Schema from "effect/Schema";

const safeLink = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }),
);

const metric = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Wire contract for the external indexer/search service, not a corpus model. */
export const resultPost = Schema.Struct({
  tweetId: Schema.String.check(Schema.isPattern(/^\d+$/)),
  author: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{1,15}$/)),
  text: Schema.String.check(Schema.isMaxLength(6000)),
  url: safeLink,
  createdAt: Schema.optional(Schema.Finite),
  likes: Schema.optional(metric),
  reposts: Schema.optional(metric),
  replies: Schema.optional(metric),
  links: Schema.Array(safeLink).pipe(Schema.mutable).check(Schema.isMaxLength(10)),
  avatar: Schema.optional(safeLink),
  displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
});

export type ResultPost = typeof resultPost.Type;

const stat = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

const backendStats = Schema.Struct({
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

const apiStats = Schema.Struct({
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

export const searchStats = Schema.Struct({
  backend: backendStats,
  api: Schema.optional(apiStats),
});

export const searchResponse = Schema.Struct({
  rows: Schema.Array(resultPost).pipe(Schema.mutable).check(Schema.isMaxLength(20)),
  nextCursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  stats: Schema.optional(searchStats),
  warnings: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(500)))
      .pipe(Schema.mutable)
      .check(Schema.isMaxLength(10)),
  ),
});

const decode = Schema.decodeUnknownSync(searchResponse);

export function decodeSearchResponse(input: unknown) {
  const result = decode(input);

  return { ...result, warnings: result.warnings ?? [] };
}
