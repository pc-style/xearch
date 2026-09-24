// Shared fixtures for the ResultsSection / ResultsHead rendered tests.
import { ResultsHead, ResultsSection, type ResultsSectionProps } from "../../src/ResultsSection";
import { ViewMode } from "../../src/uiState";
import { SearchStatus, SearchTrigger, type SearchAttemptSnapshot } from "../../src/searchTelemetry";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { ResultPost } from "../../convex/lib/results";
import { renderHtml } from "../solid";

export const configured = {
  indexing: true,
  search: true,
  firecrawl: true,
  openai: true,
  email: true,
};

export const noop = () => {};

export function post(overrides: Partial<ResultPost> = {}): ResultPost {
  return {
    tweetId: "123",
    author: "anthropicai",
    text: "hello world",
    url: "https://x.com/anthropicai/status/123",
    links: [],
    ...overrides,
  };
}

export function session(overrides: Partial<Doc<"sessions">> = {}): Doc<"sessions"> {
  const base = {
    // SAFETY: `Id<…>` is a branded string; these attach the brand to
    // test-authored ids.
    _id: "s1" as Id<"sessions">,
    _creationTime: 0,
    // SAFETY: as above — a test-authored id with the brand attached.
    owner: "user-1" as Id<"users">,
    raw: "zzzqa-no-match-918273",
    sort: "relevance" as const,
    status: "complete" as const,
    rows: [],
    warnings: [],
    ...overrides,
  };

  // SAFETY: `base` lists every required field of `Doc<"sessions">`;
  // `overrides` only narrows optional or same-shaped fields.
  return base as Doc<"sessions">;
}

export const frontendStats: SearchAttemptSnapshot = {
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

export function renderResults(props: Partial<ResultsSectionProps> = {}) {
  return renderHtml(ResultsSection, {
    view: ViewMode.Search,
    raw: "zzzqa-no-match-918273",
    sort: "relevance",
    configured,
    result: undefined,
    queryError: "",
    visible: [],
    bookmarkedIds: new Set<string>(),
    busy: false,
    onSearch: noop,
    onOpenModal: noop,
    onImportAccount: noop,
    onRetry: noop,
    onLiveSearch: noop,
    onLoadMore: noop,
    onRead: noop,
    onBookmark: noop,
    onThread: noop,
    isOperator: true,
    ...props,
  });
}

export function renderHead(props: Partial<Parameters<typeof ResultsHead>[0]> = {}) {
  return renderHtml(ResultsHead, {
    view: ViewMode.Search,
    raw: "zzzqa-no-match-918273",
    account: undefined,
    alreadySaved: false,
    busy: false,
    queryError: "",
    hasUsableResults: true,
    configured,
    isOperator: true,
    emailNeedsSignIn: false,
    onBack: noop,
    onSave: noop,
    onCopy: noop,
    onEmail: noop,
    onWebContext: noop,
    onLiveSearch: noop,
    ...props,
  });
}
