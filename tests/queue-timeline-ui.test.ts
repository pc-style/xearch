// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import type { Value } from "convex/values";
import type { Id } from "../convex/_generated/dataModel";
import type { Timeline } from "../convex/queue";
import { queueTimelineQuery } from "../src/library/queueApi";
import QueueTimeline from "../src/library/QueueTimeline";
import { CONNECTED, fakeConvex, mount, renderHtml } from "./solid";

/**
 * A rendered-DOM smoke test for src/library/QueueTimeline.tsx, following
 * tests/library-ui.test.ts's pattern: no module mocking, the component's
 * real Convex bindings running against a fake Convex app (tests/solid.ts)
 * that answers each query from this file's own per-function fixture map.
 */
interface MockState {
  isAuthenticated: boolean;
  connected: boolean;
  responses: Map<string, Value>;
  // Every mutation the rendered component actually called — asserted by the
  // Retry-button test below (src/library/QueueTimeline.tsx `onRetry` calls
  // `api.jobs.retry` directly; there is no prop to intercept it through, so
  // this fake transport is the only place that call is observable).
  mutationCalls: { name: string; args: Record<string, Value> }[];
}

const mockState: MockState = {
  isAuthenticated: true,
  connected: true,
  responses: new Map<string, Value>(),
  mutationCalls: [],
};

function convex() {
  return fakeConvex({
    query: (name) => mockState.responses.get(name),
    isAuthenticated: mockState.isAuthenticated,
    connection: { ...CONNECTED, isWebSocketConnected: mockState.connected },
    mutation: (name, args) => {
      mockState.mutationCalls.push({ name, args });

      return Promise.resolve(null);
    },
  });
}

function jobId(id: string) {
  // SAFETY: `Id<"jobs">` is `string & { __tableName: "jobs" }`, a subtype of
  // `string`; this fixture helper attaches that brand to a test-authored id.
  return id as Id<"jobs">;
}

function accountId(id: string) {
  // SAFETY: `Id<"accounts">` is `string & { __tableName: "accounts" }`, a
  // subtype of `string`; same attachment as `jobId` above.
  return id as Id<"accounts">;
}

function reset() {
  mockState.isAuthenticated = true;
  mockState.connected = true;
  mockState.responses = new Map();
  mockState.mutationCalls = [];
}

function setQuery(ref: Parameters<typeof getFunctionName>[0], value: Value) {
  mockState.responses.set(getFunctionName(ref), value);
}

function makeTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    entries: [],
    estimateInputs: { sampleSize: 0 },
    workerBusy: false,
    truncated: false,
    ...overrides,
  };
}

function renderQueueTimeline(): string {
  return renderHtml(QueueTimeline, { close: () => {} }, convex());
}

// Interactive variant of `renderQueueTimeline` that keeps the container
// mounted so a test can dispatch a real click and observe both the mutation
// call (`mockState.mutationCalls`) and any resulting DOM change.
function renderQueueTimelineInteractive(onClose: () => void = () => {}) {
  const mounted = mount(QueueTimeline, { close: onClose }, convex());

  return { container: mounted.container, unmount: mounted.unmount };
}

describe("QueueTimeline (src/library/QueueTimeline.tsx) rendered output", () => {
  it("shows an explicit loading state before the query resolves", () => {
    reset();
    const html = renderQueueTimeline();
    expect(html).toContain("Loading queue timeline");
  });

  it('shows "Nothing queued." once the query resolves with no entries', () => {
    reset();
    setQuery(queueTimelineQuery, makeTimeline());
    const html = renderQueueTimeline();
    expect(html).toContain("Nothing queued.");
    expect(html).toContain("No completed imports yet to base an estimate on.");
  });

  it("renders a throttled entry's plain-words reason and the shaded throttle band with its reset time", () => {
    reset();
    const resetAt = new Date("2026-01-01T17:31:00Z").getTime();
    setQuery(
      queueTimelineQuery,
      makeTimeline({
        entries: [
          {
            jobId: jobId("job-throttled"),
            kind: "bulk",
            input: "adam",
            account: { accountId: accountId("acct-1"), handle: "adam", name: "Adam" },
            status: "queued",
            createdAt: resetAt - 60_000,
            waitReason: { kind: "throttled", provider: "xmd", resetAt },
            estimate: { start: resetAt, finish: resetAt + 60_000 },
          },
        ],
        estimateInputs: { sampleSize: 5, secondsPerPage: 20, medianPages: 8 },
      }),
    );
    const html = renderQueueTimeline();
    expect(html).toContain("Waiting for x.md's limit to reset at");
    expect(html).toContain("x.md throttled until");
    expect(html).toContain("@adam");
    expect(html).toContain("Estimates based on 5 recent imports");
    expect(html).toContain("≈20s/page");
    expect(html).toContain("≈8 pages/account");
  });

  it("groups several rows for the same account under one identity header", () => {
    reset();
    const now = Date.now();
    setQuery(
      queueTimelineQuery,
      makeTimeline({
        workerBusy: true,
        entries: [
          {
            jobId: jobId("job-running"),
            kind: "bulk",
            input: "grouped",
            account: {
              accountId: accountId("acct-grouped"),
              handle: "grouped",
              name: "Grouped Acct",
            },
            status: "running",
            createdAt: now,
            waitReason: { kind: "running" },
            estimate: { start: now, finish: now + 30_000, accountFinish: now + 90_000 },
          },
          {
            jobId: jobId("job-retryable"),
            kind: "bulk",
            input: "grouped",
            account: {
              accountId: accountId("acct-grouped"),
              handle: "grouped",
              name: "Grouped Acct",
            },
            status: "failed",
            createdAt: now,
            waitReason: { kind: "needsRetry", throttledUntil: undefined },
            estimate: { start: now + 30_000, finish: now + 90_000, accountFinish: now + 90_000 },
          },
        ],
      }),
    );
    const html = renderQueueTimeline();
    // The account identity appears once (the group header), not once per row.
    expect(html.match(/Grouped Acct/g)?.length).toBe(1);
    expect(html).toContain("2 jobs");
    expect(html).toContain("worker busy");
    // A stopped-but-retryable job is never "behind" (that implies passive
    // queueing) or "throttled" (implies the scheduler will act on its own)
    // — it needs a person to click Retry.
    expect(html).toContain("Stopped: retry to resume");
    expect(html).toContain("download done ≈");
    // /tmp/issues.md item 3: a retryable job used to offer no control and no
    // link to the matching row anywhere else on the page.
    expect(html).toContain("Retry");
    expect(html).toContain("Show in dashboard");
  });

  it("shows terminal-retryable jobs' retry-if-now ETA and the throttle reason when x.md is still blocking a retry", () => {
    reset();
    const now = Date.now();
    const resetAt = now + 45 * 60_000;
    setQuery(
      queueTimelineQuery,
      makeTimeline({
        entries: [
          {
            jobId: jobId("job-failed-throttled"),
            kind: "bulk",
            input: "someone",
            status: "failed",
            createdAt: now,
            waitReason: { kind: "needsRetry", throttledUntil: resetAt },
            estimate: { start: resetAt, finish: resetAt + 60_000 },
          },
        ],
      }),
    );
    const html = renderQueueTimeline();
    expect(html).toContain("Stopped: retry to resume");
    expect(html).toContain("x.md throttled until");
    expect(html).toContain("if retried now");
    // Retryable but no `account` on this entry — Retry is still offered,
    // "Show in dashboard" is not (there is no account row to jump to).
    expect(html).toContain("Retry");
    expect(html).not.toContain("Show in dashboard");
  });

  it("only shows @handle for a job kind whose input actually is one — not a post URL or a live search query", () => {
    reset();
    const now = Date.now();
    setQuery(
      queueTimelineQuery,
      makeTimeline({
        entries: [
          {
            jobId: jobId("job-post"),
            kind: "post",
            input: "https://x.com/someone/status/1234567890123456789",
            status: "queued",
            createdAt: now,
            waitReason: { kind: "ready" },
            estimate: { start: now, finish: now + 60_000 },
          },
          {
            jobId: jobId("job-live"),
            kind: "live",
            input: "from:someone hello",
            status: "queued",
            createdAt: now,
            waitReason: { kind: "behind", aheadCount: 1 },
            estimate: { start: now, finish: now + 60_000 },
          },
        ],
      }),
    );
    const html = renderQueueTimeline();
    expect(html).not.toContain("@https://x.com");
    expect(html).not.toContain("@from:someone hello");
    // /tmp/issues.md item 4: a "post"/"conversation" job with no resolvable
    // account used to lose even its author here ("Post / conversation"),
    // even though the SAME job already read "Conversation on @someone's
    // post" in the "Other imports" feed (src/JobRow.tsx `jobKindLabel`).
    // Reusing `conversationLabel` (src/jobText.ts) fixes both the author and
    // the identical-rows problem (item 3): the post id makes two otherwise
    // identical failed conversations distinguishable.
    expect(html).toContain("Conversation on @someone's post #…456789");
    expect(html).toContain("Live search: from:someone hello");
  });

  it("calls jobs.retry when Retry is clicked, and Show in dashboard closes the page and sets the account's anchor hash", () => {
    reset();
    const now = Date.now();
    setQuery(
      queueTimelineQuery,
      makeTimeline({
        entries: [
          {
            jobId: jobId("job-to-retry"),
            kind: "bulk",
            input: "someone",
            account: { accountId: accountId("acct-someone"), handle: "someone", name: "Someone" },
            status: "failed",
            createdAt: now,
            waitReason: { kind: "needsRetry", throttledUntil: undefined },
            estimate: { start: now, finish: now + 60_000 },
          },
        ],
      }),
    );

    let closeCalls = 0;

    const { container, unmount } = renderQueueTimelineInteractive(() => {
      closeCalls += 1;
    });

    const buttons = [...container.querySelectorAll("button")];
    const retryButton = buttons.find((b) => b.textContent === "Retry");
    const showInDashboardButton = buttons.find((b) => b.textContent === "Show in dashboard");
    expect(retryButton).toBeDefined();
    expect(showInDashboardButton).toBeDefined();

    retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mockState.mutationCalls).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ jobId: "job-to-retry" }) }),
    ]);

    showInDashboardButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Leaves the Queue page (closes it) and sets the anchor hash the
    // dashboard's own AccountRow renders an id for — the browser's own hash
    // navigation does the scrolling once back there.
    expect(closeCalls).toBe(1);
    expect(window.location.hash).toBe("#account-acct-someone");

    unmount();
  });

  it("labels a deep-history backfill window job with its account and dated window, not a raw search string", () => {
    reset();
    const now = Date.now();
    setQuery(
      queueTimelineQuery,
      makeTimeline({
        entries: [
          {
            jobId: jobId("job-history-window"),
            kind: "live",
            input: "from:theo since:2025-11-01 until:2025-12-01",
            // Resolved via `historyFor` (convex/lib/accounts.ts
            // `resolveJobAccount`) — the whole point of that fix.
            account: { accountId: accountId("acct-theo"), handle: "theo", name: "Theo" },
            origin: "history",
            since: "2025-11-01",
            until: "2025-12-01",
            status: "running",
            createdAt: now,
            waitReason: { kind: "running" },
            estimate: { start: now, finish: now + 60_000 },
          },
        ],
      }),
    );
    const html = renderQueueTimeline();
    expect(html).toContain("@theo");
    expect(html).toContain("older history 2025-11 → 2025-12");
  });

  // CodeRabbit (PR #63): convex/jobs.ts `retry` rejects a history-window
  // job outright ("not retried on its own" — retrying it in place would
  // double-count into its backfill's `postsFound`), so offering a Retry
  // button or an "if retried now" estimate for one would advertise a
  // control this page cannot actually honor.
  it("never offers Retry or an 'if retried now' estimate for a stopped deep-history backfill window job", () => {
    reset();
    const now = Date.now();
    setQuery(
      queueTimelineQuery,
      makeTimeline({
        entries: [
          {
            jobId: jobId("job-history-stopped"),
            kind: "live",
            input: "from:theo since:2025-11-01 until:2025-12-01",
            account: { accountId: accountId("acct-theo"), handle: "theo", name: "Theo" },
            origin: "history",
            since: "2025-11-01",
            until: "2025-12-01",
            status: "failed",
            createdAt: now,
            waitReason: { kind: "needsRetry", throttledUntil: undefined },
            estimate: { start: now, finish: now + 60_000 },
          },
        ],
      }),
    );
    const html = renderQueueTimeline();
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain("Show in dashboard");
    expect(html).not.toContain("if retried now");
  });
});
