// QA report /tmp/issues.md items 9, 10, 12, 14 (2026-09-24): the search
// corpus is one shared, global index of every account anyone imported, not
// a personal "library" — copy and disabled-state bugs below all trace back
// to ResultsSection.tsx forgetting that. Rendered with plain
// renderToStaticMarkup + createElement (no ConvexProvider, no JSX file) to
// match this repo's existing no-jsdom test convention (see
// tests/signed-out-states.test.ts).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultsSection } from "../src/ResultsSection";
import { ViewMode } from "../src/uiState";
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
      isOperator: true,
      ...props,
    }),
  );
}

describe("item 9: empty-result copy describes the shared corpus, not a personal library", () => {
  it("no-match state never says 'your library'", () => {
    const html = render({
      result: session(),
    });

    expect(html).not.toMatch(/your library/i);
    expect(html).toContain("No matches in the indexed accounts yet.");
    // The import CTA stays.
    expect(html).toContain("Import an account");
  });
});

describe("item 10: an invalid query does not claim to be searching", () => {
  it("shows an error header instead of 'Finding matching posts…'", () => {
    const html = render({ queryError: "Search one author at a time." });
    expect(html).not.toMatch(/Finding matching posts/);
    expect(html).toContain("Fix the search above to see results");
  });

  it("hides Web context, Email, and Find on X entirely while the query is invalid (QA A7/B4)", () => {
    const html = render({
      queryError: "Search one author at a time.",
      visible: [post()],
    });

    // These three sit behind the "More actions" overflow menu and only act on
    // an actual result set, so the whole menu is gone (not just disabled)
    // once the query can't be used. Save search stays.
    expect(html).not.toContain("Web context");
    expect(html).not.toContain(">Email<");
    expect(html).not.toContain("Find on X");
    expect(html).not.toContain("More actions");
    expect(html).toContain("Save search");
  });

  it("hides the overflow menu when the search failed or returned nothing", () => {
    const failed = render({
      result: session({ raw: "x", status: "failed", error: "boom" }),
    });

    expect(failed).not.toContain("More actions");

    const empty = render({
      result: session({ raw: "x" }),
      visible: [],
    });

    expect(empty).not.toContain("More actions");
  });
});

describe("A7: a failed search doesn't say 'Search could not complete' twice", () => {
  it("uses different wording in the header than the error body", () => {
    const html = render({
      result: session({
        raw: '""',
        status: "failed",
        error: "The search service rejected this query.",
      }),
    });

    const occurrences = html.split("Search could not complete").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("item 12: guest Email action states what it needs up front", () => {
  it("labels the button 'Email · sign in' when the caller has no verified email", () => {
    const html = render({ visible: [post()], emailNeedsSignIn: true });
    expect(html).toContain("Email · sign in");
  });

  it("keeps the plain 'Email' label once signed in with a verified address", () => {
    const html = render({ visible: [post()], emailNeedsSignIn: false });
    expect(html).toContain(">Email<");
    expect(html).not.toContain("sign in");
  });
});

describe("item 14: bookmarks view has correct grammar and its own explanation", () => {
  it("uses singular 'post' for exactly one bookmark", () => {
    const html = render({
      view: ViewMode.Bookmarks,
      visible: [post()],
      bookmarkedIds: new Set(["123"]),
    });

    expect(html).toMatch(/1 saved post in this browser/);
    expect(html).not.toMatch(/1 saved posts/);
  });

  it("uses plural 'posts' for more than one bookmark", () => {
    const html = render({
      view: ViewMode.Bookmarks,
      visible: [post(), post({ tweetId: "456" })],
      bookmarkedIds: new Set(["123", "456"]),
    });

    expect(html).toMatch(/2 saved posts in this browser/);
  });

  it("does not reuse the search-specific scope note for bookmarks", () => {
    const html = render({
      view: ViewMode.Bookmarks,
      visible: [post()],
      bookmarkedIds: new Set(["123"]),
    });

    expect(html).not.toMatch(/come from your search service/);
    expect(html).toMatch(/stored in this browser/);
  });
});
