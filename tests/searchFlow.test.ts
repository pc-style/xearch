import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  searchFlow,
  type SearchFlowDependencies,
  type SearchRequest,
  type SearchSessionId,
} from "../src/searchFlow";

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
