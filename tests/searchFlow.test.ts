import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  mergeSearchPages,
  searchFlow,
  type SearchFlowDependencies,
  type SearchRequest,
  type SearchSessionId,
} from "../src/searchFlow";

// SAFETY: `SearchSessionId` is a branded string with no runtime
// constructor exposed to callers outside src/searchFlow.ts; this fixture
// only ever stands in for an opaque id `searchFlow` was given back by its
// own dependencies, never a value this test parses from the outside.
const sessionId = "session-1" as SearchSessionId;

const request: SearchRequest = {
  raw: "local first",
  sort: "relevance",
  includeStats: true,
};

describe("searchFlow", () => {
  it("ensures a session before starting the requested search and returns its id", async () => {
    const events: string[] = [];

    const dependencies: SearchFlowDependencies = {
      ensureSession: async () => {
        events.push("ensureSession");
      },
      startSearch: async (receivedRequest) => {
        events.push("startSearch");
        expect(receivedRequest).toEqual(request);

        return sessionId;
      },
    };

    await expect(Effect.runPromise(searchFlow(dependencies, request))).resolves.toBe(sessionId);
    expect(events).toEqual(["ensureSession", "startSearch"]);
  });

  it("sends only the mutation's own arguments, not caller telemetry fields", async () => {
    let received: object | undefined;

    const dependencies: SearchFlowDependencies = {
      ensureSession: async () => {},
      startSearch: async (receivedRequest) => {
        received = receivedRequest;

        return sessionId;
      },
    };

    const wider = { ...request, attemptId: 7, trigger: "submit" };

    await Effect.runPromise(searchFlow(dependencies, wider));
    expect(received).not.toHaveProperty("attemptId");
    expect(received).not.toHaveProperty("trigger");
  });

  it("preserves an ensureSession failure and does not start a search", async () => {
    const failure = new Error("session unavailable");
    let startCalls = 0;

    const dependencies: SearchFlowDependencies = {
      ensureSession: () => Promise.reject<void>(failure),
      startSearch: async () => {
        startCalls += 1;

        return sessionId;
      },
    };

    await expect(Effect.runPromise(searchFlow(dependencies, request))).rejects.toBe(failure);
    expect(startCalls).toBe(0);
  });

  it("preserves a startSearch failure after the session is ready", async () => {
    const failure = new Error("search unavailable");
    const events: string[] = [];

    const dependencies: SearchFlowDependencies = {
      ensureSession: async () => {
        events.push("ensureSession");
      },
      startSearch: async () => {
        events.push("startSearch");
        throw failure;
      },
    };

    await expect(Effect.runPromise(searchFlow(dependencies, request))).rejects.toBe(failure);
    expect(events).toEqual(["ensureSession", "startSearch"]);
  });

  it("preserves a non-Error rejection for describeError", async () => {
    const failure = "search unavailable";

    const dependencies: SearchFlowDependencies = {
      ensureSession: async () => {},
      startSearch: () => Promise.reject<SearchSessionId>(failure),
    };

    await expect(Effect.runPromise(searchFlow(dependencies, request))).rejects.toBe(failure);
  });
});

describe("mergeSearchPages", () => {
  const post = (tweetId: string) => ({ tweetId, text: `post ${tweetId}` });

  it("replace mode discards the base and returns only the incoming page", () => {
    const base = [post("1"), post("2")];
    const incoming = [post("3"), post("4")];
    expect(mergeSearchPages(base, incoming, "replace")).toEqual(incoming);
  });

  it("append mode keeps the base rows and adds new ones after them", () => {
    const base = [post("1"), post("2")];
    const incoming = [post("3"), post("4")];
    expect(mergeSearchPages(base, incoming, "append")).toEqual([
      post("1"),
      post("2"),
      post("3"),
      post("4"),
    ]);
  });

  it("append mode dedupes by tweetId, keeping the earlier copy", () => {
    const base = [post("1"), { tweetId: "2", text: "original" }];
    const incoming = [{ tweetId: "2", text: "duplicate from a replayed cursor" }, post("3")];
    expect(mergeSearchPages(base, incoming, "append")).toEqual([
      post("1"),
      { tweetId: "2", text: "original" },
      post("3"),
    ]);
  });

  it("replace mode also dedupes within the incoming page itself", () => {
    const incoming = [post("1"), post("1"), post("2")];
    expect(mergeSearchPages([], incoming, "replace")).toEqual([post("1"), post("2")]);
  });
});
