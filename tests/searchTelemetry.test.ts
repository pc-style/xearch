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

  // Documents why App.tsx's `resultsCommitRef`/`onResultsRender` need their
  // own `sessionAttemptRef` guard on top of this store: between starting a
  // new attempt and that attempt's own session resolving, `current.sessionId`
  // is still null, so `commitResult`'s mismatch guard (`current.sessionId &&
  // input.sessionId !== current.sessionId`) doesn't fire — it has nothing to
  // compare against yet. A caller that reads a stale, already-complete
  // result (still keyed by the PREVIOUS attempt's session, as `runLoadMore`
  // deliberately leaves `sessionId` while its new page loads) and reports it
  // for the new attempt would have it accepted here, wrongly, and then have
  // the new attempt's real completion silently dropped once the actual page
  // arrives (a terminal attempt never re-commits).
  it("accepts a terminal input for an unrelated session when no session is confirmed yet", () => {
    const store = createSearchTelemetryStore({ clock: () => 100 });
    const attempt = store.startAttempt({ trigger: SearchTrigger.NextPage });
    // No markSession call: this attempt's real session hasn't resolved yet.

    const changed = store.markTerminal({
      attemptId: attempt,
      status: SearchStatus.Complete,
      rowCount: 20,
      // A stale session from a previous attempt — not this one's.
      sessionId: sessionId(1),
    });

    expect(changed).toBe(true);
    expect(store.getSnapshot()?.terminalRowCount).toBe(20);

    // The real session for this attempt resolving afterwards is then
    // ignored, because the attempt already looks terminal.
    const realCompletion = store.markTerminal({
      attemptId: attempt,
      status: SearchStatus.Complete,
      rowCount: 40,
      sessionId: sessionId(2),
    });

    expect(realCompletion).toBe(false);
    expect(store.getSnapshot()?.terminalRowCount).toBe(20);
  });
});
