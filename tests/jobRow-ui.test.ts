import { describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { JobRow } from "../src/JobRow";
import { OPERATOR_SIGN_IN_NOTICE } from "../src/integrationStatus";
import { fakeConvex, mount, stripMarkers } from "./solid";

/**
 * A rendered-DOM test for src/JobRow.tsx — the one job row shared by the
 * header modal (src/App.tsx, public build) and the operator dashboard
 * (src/Dashboard.tsx, operator build only). Renders under the fake Convex
 * app in tests/solid.ts, so `useQuery` (for `api.jobs.receipts`) runs for
 * real against a transport that answers nothing: every job below stays
 * collapsed, and nothing here depends on the receipts list itself.
 */

function jobId(id: string) {
  // SAFETY: `Id<"jobs">` is `string & { __tableName: "jobs" }`, a subtype of
  // `string`; this fixture helper attaches that brand to a test-authored id.
  return id as Id<"jobs">;
}

function userId(id: string) {
  // SAFETY: same as `jobId` above, for `Id<"users">`.
  return id as Id<"users">;
}

function job(overrides: Partial<Doc<"jobs">>): Doc<"jobs"> {
  const base = {
    _id: jobId("job-1"),
    _creationTime: 0,
    owner: userId("user-1"),
    kind: "bulk" as const,
    input: "theo",
    refresh: false,
    status: "queued" as const,
    count: 0,
    attempt: 0,
    warnings: [],
    updatedAt: 0,
    ...overrides,
  };

  // SAFETY: `base` covers every required field of `Doc<"jobs">`; `overrides`
  // only ever narrows optional or same-shaped fields, so this is a plain
  // upcast, not a lie about its shape.
  return base as Doc<"jobs">;
}

interface RenderedRow {
  html: string;
  container: HTMLElement;
  unmount: () => void;
}

function renderRow(
  props: Omit<Parameters<typeof JobRow>[0], "job" | "now" | "isOperator"> & {
    job: Doc<"jobs">;
    now?: number;
    isOperator?: boolean;
  },
): RenderedRow {
  const mounted = mount(JobRow, { now: 0, isOperator: true, ...props }, fakeConvex());

  return {
    html: stripMarkers(mounted.html()),
    container: mounted.container,
    unmount: mounted.unmount,
  };
}

describe("JobRow (src/JobRow.tsx) rendered output", () => {
  it("labels a bulk (account history) job by handle, not the raw kind", () => {
    const { html, unmount } = renderRow({ job: job({ kind: "bulk", input: "theo" }) });

    expect(html).toContain("@theo history");
    unmount();
  });

  it("labels a post job with the handle recovered from its status URL", () => {
    const post = job({ kind: "post", input: "https://x.com/theo/status/12345" });
    const { html, unmount } = renderRow({ job: post });

    expect(html).toContain("Conversation on @theo's post");
    unmount();
  });

  // /tmp/issues.md item 3: several failed "Conversation on @handle's post"
  // rows can share the same label and the same rounded relative age — this
  // is the other half of that job's identity (the post id is the other,
  // already covered by jobKindLabel itself), and the raw URL that never
  // belongs in the main label stays available under "Technical details".
  it("shows a post job's exact start time and its raw status URL only behind Technical details", () => {
    const post = job({
      kind: "post",
      input: "https://x.com/theo/status/12345",
      _creationTime: Date.UTC(2026, 0, 1, 9, 5),
    });

    const { html, unmount } = renderRow({ job: post, now: Date.UTC(2026, 0, 1, 9, 10) });

    expect(html).toContain("started");
    expect(html).toContain("https://x.com/theo/status/12345");
    unmount();
  });

  it("never shows a raw status URL for a non-post job", () => {
    const bulk = job({ kind: "bulk", input: "theo" });
    const { html, unmount } = renderRow({ job: bulk });

    expect(html).not.toContain("started");
    unmount();
  });

  it("labels a live-search job with its query, not a raw kind string", () => {
    const live = job({ kind: "live", input: "@theo convex" });
    const { html, unmount } = renderRow({ job: live });

    expect(html).toContain("Live search: @theo convex");
    unmount();
  });

  it("offers Retry for a transient failure and hides it for a permanent one", () => {
    const transientFailure = job({
      status: "failed",
      error: "x.md rate limit reached.",
      retryable: true,
    });

    const transient = renderRow({ job: transientFailure, onRetry: () => Promise.resolve() });

    expect(transient.html).toContain(">Retry<");
    expect(transient.html).not.toContain("x.md can't fetch this");
    transient.unmount();

    const permanentFailure = job({
      kind: "post",
      input: "https://x.com/theo/status/1",
      status: "failed",
      error: "x.md could not finish this request (400, invalid_thread).",
      retryable: false,
    });

    const permanent = renderRow({ job: permanentFailure, onRetry: () => Promise.resolve() });

    expect(permanent.html).not.toContain(">Retry<");
    expect(permanent.html).toContain("x.md can't fetch this");
    permanent.unmount();
  });

  it("offers Retry for a legacy 404 on a known account", () => {
    const failure = job({
      kind: "bulk",
      status: "failed",
      expectedUserId: "123",
      error: "x.md could not finish this request (404, not_found).",
      retryable: false,
    });

    const { html, unmount } = renderRow({ job: failure, onRetry: () => Promise.resolve() });

    expect(html).toContain(">Retry<");
    unmount();
  });

  it("still offers Retry for an unclassified stopped job (no ProviderError.retryable recorded)", () => {
    // `retryable` is `undefined` for any job that predates this field, or
    // that stopped for a reason that never went through `ProviderError` —
    // isPermanentFailure() only ever treats an EXPLICIT `retryable: false`
    // as permanent, so this case still offers Retry rather than silently
    // losing the button for old rows.
    const unclassified = job({ status: "partial", count: 3 });
    const { html, unmount } = renderRow({ job: unclassified, onRetry: () => Promise.resolve() });

    expect(html).toContain(">Retry<");
    unmount();
  });

  it("calls onDismiss with the job when Clear from list is clicked, and never offers it for an active job", async () => {
    const onDismiss = vi.fn((_job: Doc<"jobs">) => Promise.resolve());
    const finished = renderRow({ job: job({ status: "complete" }), onDismiss });

    const button = [...finished.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Clear from list",
    );

    expect(button).toBeDefined();
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const [dismissed] = onDismiss.mock.calls[0]!;

    expect(dismissed._id).toBe("job-1");
    finished.unmount();

    const active = renderRow({ job: job({ status: "running" }), onDismiss });

    expect(active.html).not.toContain("Clear from list");
    active.unmount();
  });

  it("folds earlier runs of the same input into a technical-details count, without a row each", () => {
    const finished = job({ status: "complete" });
    const { html, unmount } = renderRow({ job: finished, earlierCount: 3 });

    expect(html).toContain("3 earlier runs for this same input.");
    unmount();
  });

  it("disables Cancel/Retry/Dismiss with a visible sign-in notice for a non-operator", () => {
    // Cancel/Retry/Dismiss/Restore are all `requireOperator`-gated
    // server-side (convex/access.ts, convex/jobs.ts) — a signed-in guest
    // must see why the buttons don't work, not hit a bare ConvexError.
    const retryableFailure = job({ status: "failed", retryable: true });

    const { html, container, unmount } = renderRow({
      job: retryableFailure,
      isOperator: false,
      onRetry: () => Promise.resolve(),
    });

    expect(html).toContain(OPERATOR_SIGN_IN_NOTICE);

    const retryButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry",
    );

    expect(retryButton).toBeDefined();
    expect(retryButton!.disabled).toBe(true);
    unmount();
  });
});
