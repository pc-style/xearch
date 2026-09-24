import { describe, expect, it } from "vitest";
import {
  createSearchTelemetryStore,
  SearchStatus,
  SearchTrigger,
  type SearchSessionId,
} from "../src/searchTelemetry";

// SAFETY: `SearchSessionId` is a branded string with no runtime constructor
// exposed to callers outside src/searchFlow.ts; this fixture only ever
// stands in for an opaque id the telemetry store was told about by its
// caller, never a value this test parses from the outside.
const sessionId = (n: number) => `session-${n}` as SearchSessionId;

describe("searchTelemetry / Load more attempts", () => {
  // Guards the App.tsx `runLoadMore` fix: a cursor ("Load more") request
  // must start its own telemetry attempt rather than reusing the first
  // page's. `commitResult` refuses to move an attempt from one session id
  // to another (a session swap mid-attempt would otherwise let an unrelated
  // response finish a different query's attempt), so reusing the first
  // page's attempt id for the second page's session silently drops that
  // page's terminal update — which is how "Stats for nerds" got stuck
  // showing the first page's numbers after paging.
  it("a session-id mismatch on an already-terminal attempt is dropped, not applied", () => {
    const store = createSearchTelemetryStore({ clock: () => 100 });
    const first = store.startAttempt({ trigger: SearchTrigger.Submit });
    store.markMutationStarted(first);
    store.markSession(first, sessionId(1));
    store.recordProfiler(first, 895, 10);
    store.markTerminal({
      attemptId: first,
      status: SearchStatus.Complete,
      rowCount: 20,
      sessionId: sessionId(1),
    });
    expect(store.getSnapshot()?.terminalRowCount).toBe(20);

    // Simulates the old bug: reusing `first`'s attempt id for the second
    // page's session instead of starting a new attempt.
    const changed = store.markTerminal({
      attemptId: first,
      status: SearchStatus.Complete,
      rowCount: 40,
      sessionId: sessionId(2),
    });

    expect(changed).toBe(false);
    expect(store.getSnapshot()?.terminalRowCount).toBe(20);
  });

  it("a fresh attempt for the cursor request reports its own timing, not the first page's", () => {
    const store = createSearchTelemetryStore({ clock: () => 100 });
    const first = store.startAttempt({ trigger: SearchTrigger.Submit });
    store.markMutationStarted(first);
    store.markSession(first, sessionId(1));
    store.recordProfiler(first, 895, 10);
    store.markTerminal({ attemptId: first, status: SearchStatus.Complete, rowCount: 20 });

    // What `runLoadMore` now does: allocate a new attempt id with trigger
    // NextPage instead of continuing the first page's attempt.
    const second = store.startAttempt({ trigger: SearchTrigger.NextPage });
    expect(second).not.toBe(first);

    const afterStart = store.getSnapshot();
    expect(afterStart?.attemptId).toBe(second);
    expect(afterStart?.trigger).toBe(SearchTrigger.NextPage);
    // A brand new attempt has no client timing yet — the stale 895ms from
    // the first page must not leak into it.
    expect(afterStart?.actualDurationMs).toBeNull();

    store.markMutationStarted(second);
    store.markSession(second, sessionId(2));
    store.recordProfiler(second, 40, 5);
    store.markTerminal({ attemptId: second, status: SearchStatus.Complete, rowCount: 40 });

    expect(store.getSnapshot()?.actualDurationMs).toBe(40);
  });
});
