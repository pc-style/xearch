// Regression tests for the ResultsSection.tsx CodeRabbit findings on PR #46
// (2026-09-24):
// - Keep the query-driven X import available with zero matches.
// - Announce query validation errors to screen readers.
// - Describe configuration without claiming a connection check.
// - Make statistics accessible after a zero-match search.
// Rendered with plain renderToStaticMarkup + createElement (no
// ConvexProvider, no JSX file), matching this repo's no-jsdom test
// convention (see tests/signed-out-states.test.ts and
// tests/results-section-copy.test.ts).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultsSection } from "../src/ResultsSection";
import { ViewMode } from "../src/uiState";
import { SearchStatus, SearchTrigger, type SearchAttemptSnapshot } from "../src/searchTelemetry";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { ResultPost } from "../convex/lib/results";

const configured = {
  indexing: true,
  search: true,
  firecrawl: true,
  openai: true,
  email: true,
};

const noop = () => {};

function post(overrides: Partial<ResultPost> = {}): ResultPost {
  return {
    tweetId: "123",
    author: "anthropicai",
    text: "hello world",
    url: "https://x.com/anthropicai/status/123",
    links: [],
    ...overrides,
  };
}

function sessionId(id: string) {
  // SAFETY: `Id<"sessions">` is `string & { __tableName: "sessions" }`, a
  // subtype of `string`; this fixture helper attaches that brand to a
  // test-authored id, same pattern as tests/jobText.test.ts's `jobId`/`userId`.
  return id as Id<"sessions">;
}

function userId(id: string) {
  // SAFETY: `Id<"users">` is `string & { __tableName: "users" }`, a subtype
  // of `string`; this fixture helper attaches that brand to a test-authored
  // id.
  return id as Id<"users">;
}

function session(overrides: Partial<Doc<"sessions">> = {}): Doc<"sessions"> {
  const base = {
    _id: sessionId("s1"),
    _creationTime: 0,
    owner: userId("user-1"),
    raw: "zzzqa-no-match-918273",
    sort: "relevance" as const,
    status: "complete" as const,
    rows: [],
    warnings: [],
    ...overrides,
  };

  // SAFETY: `base` covers every required field of `Doc<"sessions">` (the
  // fixture literal above lists them all); `overrides` only ever narrows
  // optional or same-shaped fields, so this is a plain upcast to the full
  // document type, not a lie about its shape.
  return base as Doc<"sessions">;
}

const frontendStats: SearchAttemptSnapshot = {
  attemptId: 1,
  trigger: SearchTrigger.Submit,
  submittedAt: 0,
  mutationStartedAt: 0,
  sessionAt: 0,
  sessionId: null,
  firstResultCommitAt: 0,
  terminalCommitAt: 0,
  status: SearchStatus.Complete,
  terminalStatus: SearchStatus.Complete,
  terminalRowCount: 0,
  nextFramePaintAt: 0,
  actualDurationMs: 1,
  baseDurationMs: 1,
  connectionAtSubmit: null,
  connectionAtSession: null,
  connectionAtTerminal: null,
};

function render(props: Partial<Parameters<typeof ResultsSection>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ResultsSection, {
      view: ViewMode.Search,
      raw: "zzzqa-no-match-918273",
      configured,
      result: undefined,
      queryError: "",
      visible: [],
      bookmarkedIds: new Set<string>(),
      busy: false,
      onSearch: noop,
      onSave: noop,
      onOpenModal: noop,
      onRetry: noop,
      onLiveSearch: noop,
      onWebContext: noop,
      onLoadMore: noop,
      onRead: noop,
      onBookmark: noop,
      onThread: noop,
      ...props,
    }),
  );
}

describe("keep the query-driven X import available with zero matches", () => {
  it("shows 'Import from X' alongside 'Import an account' on a zero-match search", () => {
    const html = render({ result: session() });
    expect(html).toContain("Import from X");
    expect(html).toContain("Import an account");
  });
});

describe("announce query validation errors to screen readers", () => {
  it("marks the invalid-query state as an alert", () => {
    const html = render({ queryError: "Search one author at a time." });
    expect(html).toMatch(/<div class="empty" role="alert">/);
  });

  it("keeps the header status text in a live region", () => {
    const html = render({ result: session() });
    expect(html).toMatch(/<p aria-live="polite">/);
  });
});

describe("describe configuration without claiming a connection check", () => {
  it("says configuration is pending, not that a connection is being checked", () => {
    const html = render({ configured: undefined });
    expect(html).toContain("Checking configuration…");
    expect(html).not.toMatch(/checking.*connection/i);
  });

  it("says search isn't configured, not that it isn't available", () => {
    const html = render({ configured: { ...configured, search: false } });
    expect(html).toMatch(/Search isn.{1,10}t configured on this site\./);
    expect(html).not.toMatch(/Search is not available on this site\./);
  });

  it("states the configuration requirement without claiming it alone enables search or calling it a connection (2nd CodeRabbit pass)", () => {
    const html = render({ configured: { ...configured, search: false } });
    expect(html).toContain("Search needs the search service to be configured for this site.");
    // The old copy called the requirement a "connection" and said
    // configuring it "will enable" search — neither is proven by
    // `configured.search` alone. The operator-only "View connections" button
    // is unrelated and stays; check the explanatory paragraph specifically.
    expect(html).not.toMatch(/<p>[^<]*connection[^<]*<\/p>/i);
    expect(html).not.toMatch(/will enable it/i);
  });
});

describe("uses singular 'post' for exactly one result on the page (2nd CodeRabbit pass)", () => {
  it("says '1 post' rather than '1 posts'", () => {
    const html = render({ result: session({ rows: [post()] }), visible: [post()] });
    expect(html).toContain("1 post on this page");
    expect(html).not.toContain("1 posts on this page");
  });

  it("still says 'N posts' for more than one", () => {
    const rows = [post(), post({ tweetId: "456" })];
    const html = render({ result: session({ rows }), visible: rows });
    expect(html).toContain("2 posts on this page");
  });
});

describe("make statistics accessible after a zero-match search", () => {
  it("still renders the stats panel when a completed search has zero matches", () => {
    const html = render({
      result: session(),
      statsForNerds: true,
      frontendStats,
    });

    expect(html).toContain("Stats for nerds —");
  });

  it("still offers the stats toggle when a completed search has zero matches", () => {
    const html = render({
      result: session(),
      onToggleStats: noop,
    });

    expect(html).toContain(">Stats for nerds<");
  });

  it("does not show stats controls for a failed search", () => {
    const html = render({
      result: session({ status: "failed", error: "boom" }),
      statsForNerds: true,
      frontendStats,
      onToggleStats: noop,
    });

    expect(html).not.toContain("Stats for nerds");
  });

  it("still works for a non-empty search (no regression)", () => {
    const html = render({
      result: session({ rows: [post()] }),
      visible: [post()],
      statsForNerds: true,
      frontendStats,
    });

    expect(html).toContain("Stats for nerds —");
  });
});
