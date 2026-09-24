// QA reports /tmp/issues-claude-qa.md A12 and /tmp/issues-claude-preview.md
// P2 (2026-09-24):
// - A12: "Save search" never showed a saved state, so clicking it twice
//   looked like nothing happened (the entry is de-duped server-side, but
//   the button was silent about it).
// - P2: the "Stats for nerds" panel rendered on every search regardless of
//   the checkbox, because ResultsSection gated it on `frontendStats`
//   existing rather than the caller's includeStats choice — client
//   telemetry is always populated once a search runs.
// Rendered with plain renderToStaticMarkup + createElement, matching this
// repo's no-jsdom test convention (tests/signed-out-states.test.ts).
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

function post(): ResultPost {
  return {
    tweetId: "123",
    author: "anthropicai",
    text: "hello world",
    url: "https://x.com/anthropicai/status/123",
    links: [],
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
    raw: "convex",
    sort: "relevance" as const,
    status: "complete" as const,
    rows: [post()],
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
  terminalRowCount: 1,
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
      raw: "convex",
      configured,
      result: session(),
      queryError: "",
      visible: [post()],
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

describe("A12: Save search reflects whether the current query+sort is already saved", () => {
  it("shows 'Save search' and stays enabled when not yet saved", () => {
    const html = render({ alreadySaved: false });
    expect(html).toContain("Save search");
    expect(html).not.toContain(">Saved<");
  });

  it("flips to a disabled 'Saved' state once it is", () => {
    const html = render({ alreadySaved: true });
    expect(html).toContain(">Saved<");
    const re = /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Saved/;
    expect(html).toMatch(re);
  });
});

describe("P2: the nerd stats panel only renders when the caller asked for it", () => {
  it("stays hidden when statsForNerds is off, even though client telemetry exists", () => {
    const html = render({ statsForNerds: false, frontendStats });
    expect(html).not.toContain("Stats for nerds —");
  });

  it("renders once statsForNerds is on", () => {
    const html = render({ statsForNerds: true, frontendStats });
    expect(html).toContain("Stats for nerds —");
  });

  it("offers a footnote toggle that reflects the current state", () => {
    const off = render({ statsForNerds: false, onToggleStats: noop });
    expect(off).toContain(">Stats for nerds<");
    const on = render({ statsForNerds: true, onToggleStats: noop });
    expect(on).toContain("Stats for nerds: on");
  });
});

describe("B6: results footnote drops the internal service copy", () => {
  it("does not mention 'search service' for the search view", () => {
    const html = render({});
    expect(html).not.toMatch(/search service/i);
  });
});
