import { describe, expect, it } from "vitest";
import { decodeSearchResponse } from "../convex/lib/results";

const post = {
  tweetId: "1234567890123456789",
  author: "example",
  text: "A searchable post",
  url: "https://x.com/example/status/1234567890123456789",
  links: ["https://example.com/article"],
};

describe("search response contract", () => {
  it("decodes an empty page and defaults omitted warnings", () => {
    expect(decodeSearchResponse({ rows: [] })).toEqual({ rows: [], warnings: [] });
  });
  it("accepts opt-in backend and API diagnostics", () => {
    const stats = {
      backend: {
        totalUs: 10,
        reloadUs: 1,
        fingerprintUs: 1,
        cursorUs: 1,
        compileUs: 1,
        retrieveUs: 3,
        rankingCalls: 2,
        materializeUs: 1,
        candidateHits: 3,
        returnedRows: 2,
        indexDocs: 100,
        segments: 1,
      },
      api: {
        totalUs: 20,
        authUs: 1,
        validateUs: 1,
        cursorVerifyUs: 1,
        parseUs: 1,
        permitUs: 1,
        queueUs: 1,
        engineUs: 11,
        postprocessUs: 1,
        cursorSignUs: 1,
      },
    };

    expect(decodeSearchResponse({ rows: [], stats })).toEqual({ rows: [], stats, warnings: [] });
    expect(() =>
      decodeSearchResponse({
        rows: [],
        stats: { ...stats, backend: { ...stats.backend, rankingCalls: -1 } },
      }),
    ).toThrow(Error);
    expect(() =>
      decodeSearchResponse({
        rows: [],
        stats: { ...stats, backend: { ...stats.backend, totalUs: 1.5 } },
      }),
    ).toThrow(Error);
  });
  it("preserves supported optional fields and strips unknown provider fields", () => {
    const row = {
      ...post,
      likes: 0,
      reposts: 1,
      replies: 2,
      createdAt: 123,
      avatar: "https://example.com/avatar.png",
      displayName: "Example",
    };

    expect(
      decodeSearchResponse({
        rows: [{ ...row, privateField: "omit" }],
        warnings: ["Partial index"],
        nextCursor: "opaque",
        extra: true,
      }),
    ).toEqual({
      rows: [row],
      warnings: ["Partial index"],
      nextCursor: "opaque",
    });
  });
  it.each([
    { tweetId: 123 },
    { tweetId: "not-an-id" },
    { author: "invalid handle" },
    { text: "a".repeat(6001) },
    { url: "javascript:alert(1)" },
    { avatar: "http://example.com/avatar" },
    { links: ["not a URL"] },
    { likes: -1 },
    { likes: Infinity },
    { createdAt: NaN },
    { displayName: "a".repeat(101) },
    { links: Array(11).fill("https://example.com") },
  ])("rejects malformed post fields: %j", (invalid) => {
    expect(() => decodeSearchResponse({ rows: [{ ...post, ...invalid }] })).toThrow(Error);
  });
  it.each([
    null,
    {},
    { rows: null },
    { rows: Array.from({ length: 21 }, () => ({ ...post })) },
    { rows: [], nextCursor: "a".repeat(4001) },
    { rows: [], warnings: Array(11).fill("warning") },
    { rows: [], warnings: ["a".repeat(501)] },
    { rows: [], warnings: null },
  ])("rejects malformed or oversized pages: %j", (input) => {
    expect(() => decodeSearchResponse(input)).toThrow(Error);
  });
  it("accepts the existing maximum page and cursor lengths", () => {
    const result = decodeSearchResponse({
      rows: Array.from({ length: 20 }, () => ({ ...post })),
      nextCursor: "a".repeat(4000),
      warnings: Array(10).fill("a".repeat(500)),
    });

    expect(result.rows).toHaveLength(20);
    expect(result.nextCursor).toHaveLength(4000);
    expect(result.warnings).toHaveLength(10);
  });
});
