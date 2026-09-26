import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Loading,
  Match,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";
import * as Effect from "effect/Effect";
import { useAction, useConvex, useMutation, useQuery } from "./data/convex";
import { useSnapshot } from "./data/snapshot";
import { useLiveNow } from "./library/clock";
import { publicRefresh } from "./data/publicRefresh";
import { fromStore } from "./data/external";
import { ResultsHead, ResultsSection } from "./ResultsSection";
import { Wall, type Account } from "./Wall";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import { EmailSignIn } from "./auth/EmailSignIn";
import { IMPORTS_UNAVAILABLE, OPERATOR_SIGN_IN_NOTICE } from "./integrationStatus";
import { ConnectionsPanel, Dashboard, OPERATOR_BUILD } from "./operatorSurface";
import { capture, captureError, identifyUser, redactEmail, resetUser } from "./posthog";
import { operatorArgs } from "./operatorToken";
import { describeError } from "./errors";
import { dedupeJobsByInput, inlineImportStatus } from "./jobText";
import { JobRow } from "./JobRow";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ResultPost } from "../convex/lib/results";
import { parseQuery, type Sort } from "../convex/lib/search";
import {
  getSnapshot,
  OPS_PATH,
  opsEntryPatch,
  opsTabFromPath,
  pushHref,
  pushLocation,
  replaceLocation,
  useLocation,
} from "./locationStore";
import { runTask } from "./runTask";
import {
  mergeSearchPages,
  searchFlow,
  type SearchRequest as FlowSearchRequest,
} from "./searchFlow";
import { createSessionGate } from "./sessionGate";
import {
  keyWebContextSegments,
  parseWebContextMarkdown,
  shortenUrlForDisplay as shortenWebContextUrl,
  truncateWebContextParagraphs,
} from "./webContextText";
import {
  createSearchTelemetryStore,
  SearchStatus,
  SearchTrigger,
  type ConvexConnectionState,
  type SearchAttemptId,
} from "./searchTelemetry";
import { ModalKind, ViewMode } from "./uiState";
import { isAlreadySaved, sortChangeQuery, sortLabel, sorts } from "./sortOptions";
import { withViewTransition } from "./viewTransition";

type SearchRequest = FlowSearchRequest & {
  readonly attemptId: SearchAttemptId;
  readonly trigger: SearchTrigger;
  readonly includeStats: boolean;
};

type Page = { title: string; text: string; url: string; collectedAt: number };

function connectionObservation(connection: {
  isWebSocketConnected: boolean;
  hasEverConnected: boolean;
}): ConvexConnectionState {
  return {
    isWebSocketConnected: connection.isWebSocketConnected,
    hasEverConnected: connection.hasEverConnected,
    connectionCount: connection.hasEverConnected ? 1 : 0,
  };
}

/** What a query is scoped to, or null when it doesn't parse. */
function parsed(raw: string) {
  try {
    return parseQuery(raw);
  } catch {
    return null;
  }
}

// A query that is only `@handle` has no keywords to rank by, so relevance
// degenerates to whatever order the index returns (oldest first in
// practice). `search()` uses this to default such a query to newest — an
// explicit sort pick always wins.
function isAccountOnlyQuery(raw: string): boolean {
  const scope = parsed(raw);

  return Boolean(scope?.author) && !scope?.text;
}

// How much of a Web context page's text to show before "Show more": a real
// preview, far short of the ~34k characters Firecrawl can return.
const WEB_CONTEXT_PREVIEW_CHARS = 2_000;

function WebContextPage(props: { page: Page; expanded: boolean; onExpand: () => void }) {
  const view = createMemo(() => {
    const paragraphs = parseWebContextMarkdown(props.page.text);

    return props.expanded
      ? { shown: paragraphs, truncated: false }
      : truncateWebContextParagraphs(paragraphs, WEB_CONTEXT_PREVIEW_CHARS);
  });

  return (
    <div class="page-text">
      <strong>{props.page.title}</strong>
      <p class="muted-copy">
        Source:{" "}
        <a href={props.page.url} target="_blank" rel="noopener noreferrer">
          {shortenWebContextUrl(props.page.url, 80)}
        </a>{" "}
        · collected {new Date(props.page.collectedAt).toLocaleString()}
      </p>
      <For each={view().shown}>
        {(paragraph) => (
          <p>
            <For each={keyWebContextSegments(paragraph)}>
              {({ segment }) =>
                segment.type === "link" ? (
                  <a
                    href={segment.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={segment.href}
                  >
                    {segment.label}
                  </a>
                ) : (
                  segment.value
                )
              }
            </For>
          </p>
        )}
      </For>
      <Show when={view().truncated}>
        <button type="button" class="text-button" onClick={() => props.onExpand()}>
          Show more
        </button>
      </Show>
    </div>
  );
}

export default function App() {
  const convex = useConvex();
  const isAuthenticated = convex.isAuthenticated;
  // Normalize the address before anything reads the route (see
  // `opsEntryPatch`): in the operator build a bare "/" becomes `/ops`, and
  // in the public build a dashboard address becomes the home page.
  const opsEntry = opsEntryPatch(getSnapshot(), OPERATOR_BUILD);

  if (opsEntry) replaceLocation(opsEntry);

  const route = useLocation();
  const initialRoute = untrack(route);
  const telemetry = createSearchTelemetryStore();
  const connection = convex.connection;
  const connectionSnapshot = () => connectionObservation(untrack(connection));

  // Attempt ids only ever grow, across both typed searches and the URL
  // versions Back/Forward bring in, so a late answer to an old attempt can
  // always be told apart from the current one.
  let attemptCounter = initialRoute.version;

  const allocateAttempt = () => {
    attemptCounter = Math.max(attemptCounter, getSnapshot().version) + 1;

    return attemptCounter;
  };

  const [draft, setDraft] = createSignal(initialRoute.raw);
  const [raw, setRaw] = createSignal(initialRoute.raw);
  const [sort, setSort] = createSignal<Sort>(initialRoute.sort);
  const [statsForNerds, setStatsForNerds] = createSignal(initialRoute.includeStats);
  const [view, setView] = createSignal<ViewMode>(initialRoute.view);

  const [searchRequest, setSearchRequest] = createSignal<SearchRequest | null>(
    initialRoute.raw.trim()
      ? {
          raw: initialRoute.raw,
          sort: initialRoute.sort,
          includeStats: initialRoute.includeStats,
          attemptId: initialRoute.version,
          trigger: SearchTrigger.InitialUrl,
        }
      : null,
  );

  const [sessionId, setSessionId] = createSignal<Id<"sessions"> | null>(null);
  // Rows accumulated across pages of the current search. A Convex session
  // only ever holds one page; this is what lets "Load more" grow the list
  // instead of swapping it. A fresh search resets it.
  const [rows, setRows] = createSignal<ResultPost[]>([]);
  let appendMode = false;
  let mergedSession: Id<"sessions"> | null = null;
  // Which page (session) each loaded row came from. `search.bookmark` only
  // accepts a post from the session it names, and after "Load more" the
  // current session holds only the latest page.
  const rowSession = new Map<string, Id<"sessions">>();

  const [modal, setModal] = createSignal<ModalKind | null>(null);
  const [savedOpen, setSavedOpen] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [accountInput, setAccountInput] = createSignal("");
  const [since, setSince] = createSignal("");
  const [accountSuggestionsOpen, setAccountSuggestionsOpen] = createSignal(false);
  const [activeAccountSuggestion, setActiveAccountSuggestion] = createSignal(-1);

  // Imports started from a result (Import from X / Fetch conversation) are
  // real x.md jobs, so their status is read live from `jobs.list`. The live
  // import is paired with the query it was started for, so its status only
  // shows while that is still the current query.
  const [liveImportJob, setLiveImportJob] = createSignal<{
    query: string;
    jobId: Id<"jobs">;
  } | null>(null);

  const [threadJobs, setThreadJobs] = createSignal<Record<string, Id<"jobs">>>({});

  const [page, setPage] = createSignal<Page | null>(null);
  const [contextPages, setContextPages] = createSignal<Page[] | null>(null);
  const [expandedContextPages, setExpandedContextPages] = createSignal<Set<string>>(new Set());
  const [reading, setReading] = createSignal(false);

  const [proposal, setProposal] = createSignal<{ query: string; explanation: string } | null>(null);

  const [copied, setCopied] = createSignal(false);
  const [justSaved, setJustSaved] = createSignal(false);

  // src/sessionGate.ts: never create an anonymous user while the client is
  // still verifying the tokens it already holds.
  const sessionGate = createSessionGate(() => convex.actions.signIn("anonymous"));
  const ensureSession = sessionGate.ensure;

  createEffect(
    () => ({ isLoading: convex.isLoading(), isAuthenticated: isAuthenticated() }),
    (state) => sessionGate.update(state),
  );

  // --- Route sync (Back/Forward, and reloads into a shared link) -----------
  // Our own navigations mark their version as applied, so this only reacts
  // to history moves the app didn't make itself.
  let appliedRouteVersion = initialRoute.version;

  const markRouteApplied = () => {
    appliedRouteVersion = getSnapshot().version;
  };

  createEffect(route, (next) => {
    if (next.version === appliedRouteVersion) return;
    appliedRouteVersion = next.version;
    attemptCounter = Math.max(attemptCounter, next.version);

    const queryChanged =
      next.raw !== untrack(raw) ||
      next.sort !== untrack(sort) ||
      next.includeStats !== untrack(statsForNerds);

    if (queryChanged) {
      setRaw(next.raw);
      setDraft(next.raw);
      setSort(next.sort);
      setStatsForNerds(next.includeStats);
      setSessionId(null);
      setRows([]);
      setSearchRequest(
        next.raw.trim()
          ? {
              raw: next.raw,
              sort: next.sort,
              includeStats: next.includeStats,
              attemptId: next.version,
              trigger: SearchTrigger.InitialUrl,
            }
          : null,
      );
      setProposal(null);
    }

    setView(next.view);
  });

  // Which dashboard tab the address is on, in the operator build only. The
  // dashboard lives at `/ops` and `/ops/<tab>`; a bare "/" with no query and
  // no `?search=1` (e.g. Back to an entry from before the `/ops` rewrite)
  // still means the dashboard there, as it always has.
  const opsTab = () => {
    if (!OPERATOR_BUILD) return null;
    const { path, search, raw } = route();

    return opsTabFromPath(path) ?? (path === "/" && !search && !raw ? "overview" : null);
  };

  // --- Data -----------------------------------------------------------------
  const accountResults = useQuery(api.search.accounts, () => ({}));
  const accounts = () => accountResults() ?? [];

  const accountSuggestions = createMemo(() => {
    const value = draft().trim().toLowerCase();

    if (value && !/^@[a-z0-9_]*$/.test(value)) return [];

    return accounts()
      .filter((account) => !value || account.handle.toLowerCase().startsWith(value.slice(1)))
      .slice(0, 8);
  });

  const accountAvatar = (handle: string) =>
    accounts().find((a) => a.handle.toLowerCase() === handle.toLowerCase())?.avatar;

  // Decoration: a failing wall read leaves the posts column out, nothing more.
  const wallPosts = useQuery(api.wall.posts, () => ({}), { soft: true });

  // Read once, and again only from the header's Refresh (src/data/
  // publicRefresh.ts). `configured.indexing` is decided against the instant
  // of the read: it used to be asked every 5 s with a ticking clock, which
  // kept every open page re-running it. What the answer means is "as of the
  // last refresh", and the page says when that was.
  const bootstrap = useSnapshot(
    api.integrations.configured,
    () => ({ now: Date.now() }),
    publicRefresh.version,
  );

  const configured = bootstrap.data;

  onSettled(() => publicRefresh.began(Date.now()));
  // A local clock for ages on screen (job rows); it never reaches a query.
  const now = useLiveNow();

  // A failed bootstrap read ends the loading state too; the notice below
  // says what went wrong.
  const libraryLoading = () =>
    accountResults() === undefined ||
    (configured() === undefined && bootstrap.error() === undefined);

  // A failed bootstrap read used to reach the error boundary through the
  // live query; a finite read reports it here instead of sitting on
  // "Loading" forever.
  createEffect(bootstrap.error, (cause) => {
    if (cause !== undefined) setNotice(describeError(cause));
  });
  // The caller's own identity. `verifiedEmail` is the one address
  // `email.send` will ever accept, so there is nothing to type at send time.
  const me = useQuery(api.auth.me, () => ({}));
  const verifiedEmail = () => (me()?.emailVerified ? (me()?.email ?? null) : null);

  // Provider-spending actions require an operator (convex/access.ts
  // `requireOperator`). `undefined` while loading: gated actions stay off,
  // and nothing claims "not an operator" before the server has said so.
  const isOperator = useQuery(api.access.isOperator, () =>
    isAuthenticated() ? operatorArgs() : "skip",
  );

  // Analytics identity follows the signed-in (non-anonymous) user, and is
  // reset when they sign out or another user takes over the session.
  let identifiedUser: string | null = null;

  createEffect(
    () => ({ user: me(), operator: isOperator() }),
    ({ user, operator }) => {
      if (!user || user.isAnonymous) {
        if (identifiedUser !== null) {
          resetUser();
          identifiedUser = null;
        }

        return;
      }

      if (identifiedUser !== null && identifiedUser !== user.id) {
        resetUser();
        identifiedUser = null;
      }

      if (operator === undefined) return;
      identifyUser(user.id, operator ? "operator" : "user");
      identifiedUser = user.id;
    },
  );

  const queryError = () => {
    try {
      parseQuery(raw());

      return "";
    } catch (e) {
      // SAFETY: `parseQuery` (convex/lib/search.ts) only throws `new Error(...)`.
      return (e as Error).message;
    }
  };

  const snapshot = useQuery(api.search.results, () => {
    const id = sessionId();

    return id && isAuthenticated() ? { sessionId: id } : "skip";
  });

  const result = () => {
    const s = snapshot();

    return s?._id === sessionId() && s?.raw === raw() && s?.sort === sort() ? s : undefined;
  };

  const jobFeed = useQuery(api.jobs.list, () => (isAuthenticated() ? {} : "skip"));
  const jobs = () => jobFeed()?.jobs ?? [];
  const savedResults = useQuery(api.search.saved, () => (isAuthenticated() ? {} : "skip"));
  const saved = () => savedResults() ?? [];
  const bookmarkResults = useQuery(api.search.bookmarks, () => (isAuthenticated() ? {} : "skip"));
  const bookmarks = () => bookmarkResults() ?? [];
  const bookmarkedIds = createMemo(() => new Set(bookmarks().map((b) => b.tweetId)));
  const deliveryResults = useQuery(api.email.deliveries, () => (isAuthenticated() ? {} : "skip"));
  const deliveries = () => deliveryResults() ?? [];

  // What `send` would deliver, shown before the person commits.
  const emailPreview = useQuery(api.email.preview, () => {
    const id = sessionId();

    return modal() === ModalKind.Email && id && isAuthenticated() ? { sessionId: id } : "skip";
  });

  const startSearch = useMutation(api.search.start);
  const start = useMutation(api.jobs.start);
  const retry = useMutation(api.jobs.retry);
  const cancelJob = useMutation(api.jobs.cancel);
  const dismissInput = useMutation(api.jobs.dismissInput);
  const bookmark = useMutation(api.search.bookmark);
  const save = useMutation(api.search.save);
  const removeSaved = useMutation(api.search.removeSaved);
  const send = useMutation(api.email.send);
  const webContext = useAction(api.integrations.webContext);
  const readLink = useAction(api.integrations.readLink);
  const interpret = useAction(api.integrations.interpret);

  const telemetrySnapshot = fromStore(telemetry.subscribe, telemetry.getSnapshot);

  const frontendStats = () => {
    const current = telemetrySnapshot();

    return current && current.attemptId === searchRequest()?.attemptId ? current : null;
  };

  // --- Searching --------------------------------------------------------------
  // Written only from handlers and effects, read only from async
  // continuations: plain variables, not signals.
  let latestAttempt: number | null = null;
  let kickedAttempt: number | null = null;
  // Which attempt's session is confirmed. "Load more" starts a new attempt
  // but leaves the old session on screen until the new page resolves; this
  // keeps telemetry from reading that old page as the new attempt's.
  let sessionAttempt: number | null = null;
  // For analytics: when each attempt started, and which already reported
  // their outcome (a session keeps updating after it completes).
  const searchStartedAt = new Map<number, number>();
  const capturedResults = new Set<number>();

  function runSearch(request: SearchRequest): boolean {
    telemetry.startAttempt({
      attemptId: request.attemptId,
      trigger: request.trigger,
      connection: connectionSnapshot(),
    });

    // The request's own query, not `raw()`: a view transition applies the
    // state that goes with this request a frame later.
    if (!untrack(configured)?.search || !parsed(request.raw)) return false;
    searchStartedAt.set(request.attemptId, performance.now());
    latestAttempt = request.attemptId;
    setBusy(true);
    setNotice("");
    void Effect.runPromise(
      searchFlow(
        {
          ensureSession,
          beforeStart: () => telemetry.markMutationStarted(request.attemptId),
          startSearch,
        },
        request,
      ),
    ).then(
      (id) => {
        if (latestAttempt !== request.attemptId) return;

        if (telemetry.markSession(request.attemptId, id, connectionSnapshot()))
          sessionAttempt = request.attemptId;
        setSessionId(id);
        setBusy(false);
      },
      (cause: unknown) => {
        if (latestAttempt !== request.attemptId) return;
        captureError(cause instanceof Error ? cause : new Error(describeError(cause)), "search");
        capture("search_failed", {
          query: redactEmail(request.raw),
          trigger: request.trigger,
          sort: request.sort,
        });
        setNotice(describeError(cause));
        setBusy(false);
      },
    );

    return true;
  }

  // Kick a pending search (the initial URL, or one Back/Forward brought in)
  // once search is known to be configured.
  createEffect(
    () => ({ request: searchRequest(), ready: configured()?.search }),
    ({ request }) => {
      if (request !== null && kickedAttempt !== request.attemptId && runSearch(request))
        kickedAttempt = request.attemptId;
    },
  );

  // Fold a freshly landed page into `rows`, and time the DOM update it
  // causes for "Stats for nerds" (the next effect reads the clock once the
  // rows are on screen).
  let mergeStartedAt: number | null = null;

  createEffect(result, (current) => {
    if (
      current &&
      current._id === untrack(sessionId) &&
      current.status === "complete" &&
      mergedSession !== current._id
    ) {
      mergedSession = current._id;
      mergeStartedAt = performance.now();

      if (!appendMode) rowSession.clear();

      for (const row of current.rows)
        if (!rowSession.has(row.tweetId)) rowSession.set(row.tweetId, current._id);
      setRows((prev) => mergeSearchPages(prev, current.rows, appendMode ? "append" : "replace"));
    }

    const request = untrack(searchRequest);

    if (!current || !request || sessionAttempt !== request.attemptId) return;

    if (current.status === "complete" || current.status === "failed") {
      if (!capturedResults.has(request.attemptId)) {
        capturedResults.add(request.attemptId);
        capture(current.status === "complete" ? "search_results_loaded" : "search_failed", {
          query: redactEmail(request.raw),
          trigger: request.trigger,
          sort: request.sort,
          result_count: current.rows.length,
          duration_ms: Math.round(
            performance.now() - (searchStartedAt.get(request.attemptId) ?? performance.now()),
          ),
          session_id: current._id,
        });
        searchStartedAt.delete(request.attemptId);
      }

      telemetry.markTerminal({
        attemptId: request.attemptId,
        status: current.status === "complete" ? SearchStatus.Complete : SearchStatus.Failed,
        rowCount: current.rows.length,
        sessionId: current._id,
        connection: connectionSnapshot(),
      });
    } else {
      telemetry.markResultCommit({
        attemptId: request.attemptId,
        status: current.status === "running" ? SearchStatus.Running : SearchStatus.Queued,
        rowCount: current.rows.length,
        sessionId: current._id,
        connection: connectionSnapshot(),
      });
    }
  });

  createEffect(rows, () => {
    const request = untrack(searchRequest);

    if (mergeStartedAt === null || !request || sessionAttempt !== request.attemptId) return;
    const elapsed = performance.now() - mergeStartedAt;
    mergeStartedAt = null;
    telemetry.recordProfiler(request.attemptId, elapsed, elapsed);
  });

  /** Run a handler's async work, reporting through the one notice line. */
  function task(work: Promise<unknown>, success?: string, onSettledFn?: () => void): void {
    setNotice("");
    setBusy(true);
    runTask(() => work, {
      onSuccess: () => {
        if (success !== undefined) setNotice(success);
      },
      onError: (e) => setNotice(describeError(e)),
      onSettled: () => {
        setBusy(false);
        onSettledFn?.();
      },
    });
  }

  const search = (query: string, nextSort?: Sort) => {
    const trimmed = query.trim();
    const effectiveSort = nextSort ?? (isAccountOnlyQuery(trimmed) ? "newest" : sort());
    appendMode = false;
    const attemptId = allocateAttempt();

    const request: SearchRequest = {
      raw: trimmed,
      sort: effectiveSort,
      includeStats: statsForNerds(),
      attemptId,
      trigger: SearchTrigger.Submit,
    };

    setSavedOpen(false);
    withViewTransition(() => {
      setRaw(trimmed);
      setDraft(trimmed);
      setSort(effectiveSort);
      setSessionId(null);
      setRows([]);
      setSearchRequest(trimmed ? request : null);
      setView(ViewMode.Search);
      setProposal(null);

      // The operator build also pins `search: true`, or clearing the query
      // would drop both `q=` and `search=1` and bounce to the dashboard.
      pushLocation({
        raw: trimmed,
        sort: effectiveSort,
        includeStats: statsForNerds(),
        view: ViewMode.Search,
        search: OPERATOR_BUILD ? true : undefined,
      });
      markRouteApplied();
      window.scrollTo(0, 0);

      // A browser may delay this callback until after a fast mutation resolves.
      // Start only after the new view has cleared the previous session.
      if (trimmed && runSearch(request)) kickedAttempt = request.attemptId;
    });
  };

  const goHome = () => {
    if (!raw() && view() === ViewMode.Search) return;
    search("");
  };

  const retrySearch = () => {
    const request: SearchRequest = {
      raw: raw(),
      sort: sort(),
      includeStats: statsForNerds(),
      attemptId: allocateAttempt(),
      trigger: SearchTrigger.Retry,
    };

    appendMode = false;
    setSessionId(null);
    setRows([]);
    setSearchRequest(request);

    if (runSearch(request)) kickedAttempt = request.attemptId;
  };

  const loadMore = () => {
    const cursor = result()?.nextCursor;

    if (!cursor) return;
    appendMode = true;

    // Its own telemetry attempt, so the stats panel times this page rather
    // than freezing on the first one. `sessionId` stays put until the new
    // page resolves, so the list doesn't blink to a loading state.
    const request: SearchRequest = {
      raw: raw(),
      sort: sort(),
      cursor,
      includeStats: result()?.includeStats === true,
      attemptId: allocateAttempt(),
      trigger: SearchTrigger.NextPage,
    };

    setSearchRequest(request);

    if (runSearch(request)) kickedAttempt = request.attemptId;
  };

  const toggleStats = () => {
    const next = !statsForNerds();

    setStatsForNerds(next);
    // `replace`: a display preference, not a destination for Back.
    replaceLocation({ includeStats: next });
    markRouteApplied();
  };

  const toggleBookmarks = () => {
    const next = view() === ViewMode.Bookmarks ? ViewMode.Search : ViewMode.Bookmarks;

    setSavedOpen(false);
    withViewTransition(() => {
      setView(next);
      pushLocation({ view: next, includeStats: statsForNerds() });
      markRouteApplied();
      window.scrollTo(0, 0);
    });
  };

  // --- Paid / session-bound actions ---------------------------------------------
  const runLoadLive = async () => {
    await ensureSession();
    const query = raw();

    const jobId = await start({
      kind: "live",
      input: query.replace(/(^|\s)@([\w]+)/g, "$1from:$2"),
      ...operatorArgs(),
    });

    setLiveImportJob({ query, jobId });
  };

  const read = (url: string) => {
    setReading(true);
    task(
      (async () => {
        await ensureSession();
        setPage(await readLink({ url, ...operatorArgs() }));
      })(),
      undefined,
      () => setReading(false),
    );
  };

  const runWebContext = () =>
    task(
      (async () => {
        await ensureSession();
        setContextPages(await webContext({ query: raw(), ...operatorArgs() }));
        setExpandedContextPages(new Set<string>());
      })(),
    );

  const proposeSearch = () =>
    task(
      (async () => {
        await ensureSession();
        setProposal(await interpret({ raw: draft(), ...operatorArgs() }));
      })(),
    );

  const runThread = (post: ResultPost) =>
    task(
      (async () => {
        await ensureSession();
        const jobId = await start({ kind: "post", input: post.url, ...operatorArgs() });
        setThreadJobs((prev) => ({ ...prev, [post.tweetId]: jobId }));
      })(),
    );

  const toggleBookmark = (post: ResultPost) =>
    task(
      (async () => {
        await ensureSession();

        const added = await bookmark({
          tweetId: post.tweetId,
          sessionId: rowSession.get(post.tweetId) ?? sessionId() ?? undefined,
        });

        if (!added) return;
        capture("result_bookmarked", {
          query: redactEmail(raw()),
          result_url: redactEmail(post.url),
        });
        capture("search_success", { method: "bookmarked", query: redactEmail(raw()) });
      })(),
    );

  const savedEntry = () => saved().find((s) => s.query === raw().trim() && s.sort === sort());
  const alreadySaved = () => isAlreadySaved(saved(), raw(), sort());

  const toggleSaved = () => {
    const entry = savedEntry();

    if (entry) return task(removeSaved({ id: entry._id }));

    task(
      (async () => {
        await ensureSession();
        await save({ raw: raw(), sort: sort() });
        capture("search_saved", { query: redactEmail(raw()), sort: sort() });
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1600);
      })(),
    );
  };

  const copyLink = () => {
    void navigator.clipboard?.writeText(window.location.href).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => setNotice("Couldn’t copy. Select the address bar and copy the link from there."),
    );
  };

  const openImport = (handle = "") => {
    setAccountInput(handle ? `@${handle}` : "");
    setModal(ModalKind.Imports);
  };

  const openDashboard = () => {
    if (!OPERATOR_BUILD) return;
    setModal(null);
    pushHref(OPS_PATH);
  };

  // The dashboard and account rows both open the operator build's search view.
  // `?search=1` keeps the operator build on search
  // with an empty query; a query goes through the URL like a shared link.
  const openSearch = (query?: string) => {
    pushHref(query ? `/?search=1&q=${encodeURIComponent(query)}` : "/?search=1");
    window.scrollTo(0, 0);
  };

  // --- Derived view state ---------------------------------------------------------
  const home = () => !raw() && view() === ViewMode.Search;
  const visible = () => (view() === ViewMode.Bookmarks ? bookmarks() : rows());
  const scope = () => parsed(raw());

  const scopedAccount = (): Account | undefined => {
    const author = scope()?.author;

    return author ? accounts().find((a) => a.handle.toLowerCase() === author) : undefined;
  };

  const unknownAuthor = () => {
    const author = scope()?.author;

    return author && accountResults() !== undefined && !scopedAccount() ? author : undefined;
  };

  const hasUsableResults = () =>
    view() === ViewMode.Search &&
    !queryError() &&
    result()?.status !== "failed" &&
    visible().length > 0;

  // --- Keyboard -------------------------------------------------------------------------
  onSettled(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);

      if (e.key === "Escape") {
        if (savedOpen()) {
          setSavedOpen(false);

          return;
        }

        if (!typing && !modal() && !home()) goHome();

        return;
      }

      if (e.key === "/" && !typing && !modal()) {
        e.preventDefault();
        document.getElementById("query")?.focus();

        return;
      }

      // "Stats for nerds": `?` outside form fields, or Cmd/Ctrl+Shift+S anywhere.
      const isToggle =
        (e.key === "?" && !typing) ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s");

      if (!isToggle) return;
      e.preventDefault();
      toggleStats();
    };

    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || e.target.closest(".menu")) return;
      setSavedOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
    };
  });

  return (
    <Switch>
      <Match when={OPERATOR_BUILD && opsTab() && Dashboard}>
        {(Board) => {
          const Component = Board();

          return (
            <Loading fallback={null}>
              <Component
                tab={opsTab() ?? "overview"}
                ensureSession={ensureSession}
                openSearch={openSearch}
              />
            </Loading>
          );
        }}
      </Match>
      {/* The search app lives at "/" (its views are query params) and the
          dashboard is matched above, so any other path is unknown. */}
      <Match when={route().path !== "/"}>
        <div class="page not-found">
          <h1>Page not found</h1>
          <p>There's nothing at this address.</p>
          <a class="imp" href={OPERATOR_BUILD ? "/?search=1" : "/"}>
            Back to search
          </a>
        </div>
      </Match>
      <Match when={true}>
        <div class="page">
          <header class="top">
            <button type="button" class="logo press" aria-label="Xearch home" onClick={goHome}>
              xearch <i>.</i>
            </button>
            <nav class="links" aria-label="Main navigation">
              <Show when={OPERATOR_BUILD}>
                <button
                  type="button"
                  class="nav"
                  aria-label="Import dashboard"
                  onClick={openDashboard}
                >
                  <Icon name="layout-dashboard" />
                  <span class="lbl">Dashboard</span>
                </button>
              </Show>
              <button
                type="button"
                class="nav"
                aria-label="Refresh"
                title={
                  bootstrap.fetchedAt()
                    ? `Re-read this page's status · last read ${new Date(bootstrap.fetchedAt()!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : "Re-read this page's status"
                }
                onClick={() => {
                  const message = publicRefresh.request(Date.now());

                  setNotice(message ?? "");
                }}
              >
                <Icon name="refresh-cw" />
                <span class="lbl">Refresh</span>
              </button>
              <div class="menu">
                <button
                  type="button"
                  class="nav"
                  aria-label="Saved searches"
                  aria-expanded={savedOpen() ? "true" : "false"}
                  aria-controls="saved-pop"
                  onClick={() => {
                    setSavedOpen(!savedOpen());
                  }}
                >
                  <Icon name="clock" />
                  <span class="lbl">Saved searches</span>
                  <Show when={saved().length}>
                    <span class="badge">{saved().length}</span>
                  </Show>
                </button>
                <Show when={savedOpen()}>
                  <div class="pop on" id="saved-pop">
                    <h3>Saved searches</h3>
                    <Show
                      when={saved().length}
                      fallback={
                        <p>
                          Nothing saved yet. Run a search, then press the bookmark next to its
                          title.
                        </p>
                      }
                    >
                      <For each={saved()} keyed={(s) => s._id}>
                        {(item) => (
                          <div class="pi">
                            <button type="button" onClick={() => search(item().query, item().sort)}>
                              <b>{item().query}</b>
                              <small>{sortLabel(item().sort)}</small>
                            </button>
                            <button
                              type="button"
                              class="rm-x"
                              aria-label={`Remove ${item().query}`}
                              onClick={() => task(removeSaved({ id: item()._id }))}
                            >
                              <Icon name="x" size={14} />
                            </button>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
              </div>
              <button
                type="button"
                class="nav"
                aria-label="Bookmarks"
                aria-pressed={view() === ViewMode.Bookmarks ? "true" : "false"}
                onClick={toggleBookmarks}
              >
                <Icon name="bookmark" />
                <span class="lbl">Bookmarks</span>
                <Show when={bookmarks().length}>
                  <span class="badge">{bookmarks().length}</span>
                </Show>
              </button>
              <button
                type="button"
                class="imp press"
                aria-label="Import account"
                onClick={() => openImport()}
              >
                <Icon name="plus" />
                <span class="lbl">Import account</span>
              </button>
            </nav>
          </header>
          <Show when={!connection().isWebSocketConnected}>
            <p class="connection" role="status">
              <span class="connection-dot" />
              {connection().hasEverConnected
                ? "Reconnecting to the search library…"
                : "Connecting to the search library…"}
            </p>
          </Show>

          <main id="app" data-view={home() ? "home" : "results"}>
            <div class="main-col">
              <Show when={!home()}>
                <ResultsHead
                  view={view()}
                  raw={raw()}
                  account={scopedAccount()}
                  alreadySaved={alreadySaved()}
                  justSaved={justSaved()}
                  copied={copied()}
                  busy={busy()}
                  queryError={queryError()}
                  hasUsableResults={hasUsableResults()}
                  configured={configured()}
                  isOperator={isOperator()}
                  emailNeedsSignIn={!verifiedEmail()}
                  onBack={goHome}
                  onSave={toggleSaved}
                  onCopy={copyLink}
                  onEmail={() => setModal(ModalKind.Email)}
                  onWebContext={runWebContext}
                  onLiveSearch={() => task(runLoadLive())}
                />
              </Show>

              <div class="hero">
                <h1>
                  They said it.
                  <br />
                  <em>Xearch</em> it.
                </h1>
              </div>

              <form
                id="form"
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();

                  if (draft().trim()) {
                    setAccountSuggestionsOpen(false);
                    capture("search_submitted", {
                      query: redactEmail(draft().trim()),
                      sort: sort(),
                    });
                    search(draft());
                  } else document.getElementById("query")?.focus();
                }}
              >
                <label class="sr" for="query">
                  Search posts
                </label>
                <div class="row">
                  <div
                    class="q"
                    onFocusOut={(event) => {
                      if (
                        !(event.relatedTarget instanceof Node) ||
                        !event.currentTarget.contains(event.relatedTarget)
                      )
                        setAccountSuggestionsOpen(false);
                    }}
                  >
                    <Icon name="search" size={18} />
                    <input
                      id="query"
                      name="query"
                      type="search"
                      maxlength={300}
                      value={draft()}
                      onInput={(e) => {
                        setDraft(e.currentTarget.value);
                        setActiveAccountSuggestion(-1);
                        setAccountSuggestionsOpen(true);
                      }}
                      onFocus={() => setAccountSuggestionsOpen(true)}
                      onKeyDown={(event) => {
                        if (!accountSuggestionsOpen() || !accountSuggestions().length) return;

                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          const step = event.key === "ArrowDown" ? 1 : -1;
                          setActiveAccountSuggestion(
                            (index) =>
                              (index + step + accountSuggestions().length) %
                              accountSuggestions().length,
                          );
                        } else if (event.key === "Enter" && activeAccountSuggestion() >= 0) {
                          event.preventDefault();
                          setDraft(`@${accountSuggestions()[activeAccountSuggestion()].handle}`);
                          setAccountSuggestionsOpen(false);
                        } else if (event.key === "Escape") {
                          setAccountSuggestionsOpen(false);
                        }
                      }}
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls="account-suggestions"
                      aria-expanded={
                        accountSuggestionsOpen() && accountSuggestions().length > 0
                          ? "true"
                          : "false"
                      }
                      aria-activedescendant={
                        activeAccountSuggestion() >= 0 && accountSuggestionsOpen()
                          ? `account-suggestion-${activeAccountSuggestion()}`
                          : undefined
                      }
                      placeholder={
                        scopedAccount()
                          ? `e.g. GPUs in @${scopedAccount()!.handle}’s posts`
                          : "e.g. local-first software or @handle"
                      }
                      autocomplete="off"
                    />
                    <Show when={accountSuggestionsOpen() && accountSuggestions().length > 0}>
                      <div id="account-suggestions" class="account-suggestions" role="listbox">
                        <For each={accountSuggestions()}>
                          {(account, index) => (
                            <button
                              id={`account-suggestion-${index()}`}
                              type="button"
                              role="option"
                              aria-selected={
                                activeAccountSuggestion() === index() ? "true" : "false"
                              }
                              onClick={() => {
                                setDraft(`@${account.handle}`);
                                document.getElementById("query")?.focus();
                                setAccountSuggestionsOpen(false);
                              }}
                            >
                              <strong>@{account.handle}</strong>
                              <span>{account.name}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                  <select
                    class="sort"
                    aria-label="Sort results"
                    onChange={(e) => {
                      // SAFETY: every <option> comes from `sorts`, whose values are `Sort`s.
                      const nextSort = e.currentTarget.value as Sort;
                      const query = sortChangeQuery(draft(), raw());

                      if (query !== null) search(query, nextSort);
                      else setSort(nextSort);
                    }}
                  >
                    <For each={sorts}>
                      {(s) => (
                        <option value={s.value} selected={s.value === sort()}>
                          {s.label}
                        </option>
                      )}
                    </For>
                  </select>
                  <button type="submit" class="go press">
                    Xearch
                  </button>
                </div>
                <div class="meta">
                  <Show
                    when={scopedAccount() && !home()}
                    fallback={
                      <span>
                        Start with <span class="at">@</span> to search one account.
                      </span>
                    }
                  >
                    <span class="scope">
                      Only <b>@{scopedAccount()!.handle}</b>.{" "}
                      <button
                        type="button"
                        onClick={() => (scope()?.text ? search(scope()!.text) : goHome())}
                      >
                        Search every account
                      </button>
                    </span>
                  </Show>
                  <span class="opts">
                    <label title="Also toggles with ? or ⌘⇧S">
                      <input type="checkbox" checked={statsForNerds()} onChange={toggleStats} />
                      Stats for nerds
                    </label>
                    {/* An OpenAI call: only offered where it can run. */}
                    <Show when={configured()?.openai && isOperator()}>
                      <button
                        type="button"
                        class="help press"
                        disabled={busy() || !draft().trim()}
                        onClick={proposeSearch}
                      >
                        <Icon name="compass" />
                        Help me search
                      </button>
                    </Show>
                  </span>
                </div>
              </form>

              <Show when={proposal()}>
                {(p) => (
                  <div class="proposal">
                    <div>
                      <strong>{p().query}</strong>
                      <p>{p().explanation}</p>
                    </div>
                    <button
                      type="button"
                      class="imp"
                      onClick={() => {
                        setDraft(p().query);
                        setProposal(null);
                        document.getElementById("query")?.focus();
                      }}
                    >
                      Use this query
                    </button>
                  </div>
                )}
              </Show>

              <Show when={!home()}>
                <ResultsSection
                  view={view()}
                  raw={raw()}
                  sort={sort()}
                  configured={configured()}
                  result={result()}
                  queryError={queryError()}
                  visible={visible()}
                  bookmarkedIds={bookmarkedIds()}
                  busy={busy()}
                  unknownAuthor={unknownAuthor()}
                  onSearch={search}
                  onOpenModal={(which) => setModal(which)}
                  onImportAccount={openImport}
                  onRetry={retrySearch}
                  onLiveSearch={() => task(runLoadLive())}
                  onLoadMore={loadMore}
                  onRead={read}
                  onBookmark={toggleBookmark}
                  onThread={runThread}
                  liveImportStatus={
                    liveImportJob()?.query === raw()
                      ? inlineImportStatus(jobs().find((j) => j._id === liveImportJob()?.jobId))
                      : null
                  }
                  threadStatus={(tweetId) =>
                    inlineImportStatus(jobs().find((j) => j._id === threadJobs()[tweetId]))
                  }
                  frontendStats={frontendStats()}
                  statsForNerds={statsForNerds()}
                  isOperator={isOperator()}
                  avatarFor={accountAvatar}
                />
              </Show>
            </div>

            <Show when={home()}>
              <Wall
                accounts={accounts()}
                posts={wallPosts() ?? []}
                loading={libraryLoading()}
                onAccount={(handle) => search(`@${handle}`)}
              />
            </Show>
          </main>

          <footer class="foot">
            <a href="https://mdfromx.com" target="_blank" rel="noreferrer">
              Powered by x.md
            </a>
            <Show when={OPERATOR_BUILD}>
              <button type="button" onClick={() => setModal(ModalKind.Setup)}>
                <Icon name="sliders" size={13} />
                Connections
              </button>
            </Show>
          </footer>
        </div>

        <Show when={notice() || reading()}>
          <div class="toast on" role="status">
            <span>{reading() ? "Reading the linked page…" : notice()}</span>
            <Show when={!reading()}>
              <button
                type="button"
                class="ib"
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                <Icon name="x" size={14} />
              </button>
            </Show>
          </div>
        </Show>

        <Show when={modal() === ModalKind.Imports}>
          <Modal notice={notice()} title="Import an account" close={() => setModal(null)}>
            <p class="muted-copy">
              Collect an account's public history from X. You'll see its progress below.
            </p>
            <Show when={isAuthenticated() && isOperator() === false}>
              <p class="config-warning">{OPERATOR_SIGN_IN_NOTICE}</p>
            </Show>
            <form
              class="stack-form"
              onSubmit={(e) => {
                e.preventDefault();
                task(
                  (async () => {
                    await ensureSession();
                    await start({
                      kind: "bulk",
                      input: accountInput(),
                      since: since() || undefined,
                      ...operatorArgs(),
                    });
                    setAccountInput("");
                  })(),
                  "Import started. You'll see its progress in Recent imports.",
                );
              }}
            >
              <label for="account">X handle</label>
              <input
                id="account"
                value={accountInput()}
                onInput={(e) => setAccountInput(e.currentTarget.value)}
                placeholder="@handle"
                required
                maxlength={16}
              />
              <label for="since">
                History since <small>Optional, YYYY-MM-DD</small>
              </label>
              <input
                id="since"
                inputmode="numeric"
                pattern="\d{4}-\d{2}-\d{2}"
                placeholder="YYYY-MM-DD"
                value={since()}
                onInput={(e) => setSince(e.currentTarget.value)}
              />
              <button
                class="go"
                type="submit"
                disabled={busy() || !configured()?.indexing || !isOperator()}
              >
                <Icon name="download" />
                Import posts
              </button>
              <Show when={configured() && !configured()!.indexing}>
                <p class="config-warning">{IMPORTS_UNAVAILABLE}</p>
              </Show>
              <Show when={OPERATOR_BUILD}>
                <button type="button" class="text-button" onClick={openDashboard}>
                  More options in the dashboard <Icon name="arrow-up-right" size={13} />
                </button>
              </Show>
            </form>
            <div class="jobs">
              <h3>Recent imports</h3>
              <Show when={!jobs().length}>
                <p class="muted-copy">Your imports and their progress will appear here.</p>
              </Show>
              {/* Repeat runs of the exact same input fold into one row — see
                  dedupeJobsByInput's own comment. */}
              <For each={dedupeJobsByInput(jobs())} keyed={(row) => row.job._id}>
                {(row) => (
                  <JobRow
                    job={row().job}
                    now={now()}
                    earlierCount={row().earlierCount}
                    isOperator={isOperator()}
                    onCancel={async (j) => {
                      await ensureSession();
                      await cancelJob({ jobId: j._id, ...operatorArgs() });
                    }}
                    // Resumes THIS job where it stopped — never a new job.
                    onRetry={async (j) => {
                      await ensureSession();
                      await retry({ jobId: j._id, ...operatorArgs() });
                    }}
                    // Dismisses the whole folded group server-side.
                    onDismiss={async (j) => {
                      await ensureSession();
                      await dismissInput({ kind: j.kind, input: j.input, ...operatorArgs() });
                    }}
                  />
                )}
              </For>
            </div>
          </Modal>
        </Show>

        <Show when={modal() === ModalKind.Email}>
          <Modal notice={notice()} title="Email these results" close={() => setModal(null)}>
            <Switch>
              <Match when={me() === undefined}>
                <p class="muted-copy">Checking your account…</p>
              </Match>
              <Match when={!verifiedEmail()}>
                <p class="muted-copy">
                  Sending requires a verified email address, so results only ever go to you. Search
                  and every other feature stay available without one.
                </p>
                <EmailSignIn
                  class="stack-form"
                  onSignedIn={() =>
                    setNotice("Signed in. You can now preview and send this digest.")
                  }
                />
              </Match>
              <Match when={verifiedEmail()}>
                {(email) => (
                  <>
                    <p class="muted-copy">
                      {emailPreview()
                        ? `First ${emailPreview()!.rowCount} of ${emailPreview()!.totalCount} results for "${raw()}", with original post links.`
                        : `Send the first 10 matches for "${raw()}", with original post links.`}{" "}
                      Sending happens only when you press the button below.
                    </p>
                    <Show when={emailPreview()}>
                      <p class="muted-copy">Subject: {emailPreview()!.subject}</p>
                    </Show>
                    <form
                      class="stack-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const id = sessionId();

                        if (!id) return;
                        task(
                          (async () => {
                            await ensureSession();
                            await send({ sessionId: id, recipient: email() });
                          })(),
                          "Email queued. Delivery status appears below.",
                        );
                      }}
                    >
                      <p>
                        Sends to your verified address: <strong>{email()}</strong>
                      </p>
                      <button class="go" type="submit" disabled={busy() || !sessionId()}>
                        Send results
                      </button>
                    </form>
                  </>
                )}
              </Match>
            </Switch>
            <For each={deliveries()} keyed={(d) => d._id}>
              {(d) => (
                <p class="delivery">
                  {d().query}: {d().delivery?.status ?? "unknown"}
                </p>
              )}
            </For>
          </Modal>
        </Show>

        <Show when={OPERATOR_BUILD && modal() === ModalKind.Setup && ConnectionsPanel}>
          {(Panel) => {
            const Component = Panel();

            return (
              <Modal notice={notice()} title="Connections" close={() => setModal(null)}>
                <Loading fallback={<p class="muted-copy">Loading…</p>}>
                  <Component />
                </Loading>
              </Modal>
            );
          }}
        </Show>

        <Show when={page()}>
          {(p) => (
            <Modal title={p().title} close={() => setPage(null)}>
              <p class="muted-copy">Collected {new Date(p().collectedAt).toLocaleString()}</p>
              <p class="page-text">{p().text}</p>
              <a href={p().url} target="_blank" rel="noreferrer">
                <Icon name="external-link" size={14} />
                Open original page
              </a>
            </Modal>
          )}
        </Show>

        <Show when={contextPages()}>
          {(pages) => (
            <Modal title="Web context" close={() => setContextPages(null)}>
              <Show
                when={pages().length}
                fallback={<p class="muted-copy">No linked pages found for this search.</p>}
              >
                <For each={pages()} keyed={(p) => p.url}>
                  {(p) => (
                    <WebContextPage
                      page={p()}
                      expanded={expandedContextPages().has(p().url)}
                      onExpand={() => setExpandedContextPages((prev) => new Set(prev).add(p().url))}
                    />
                  )}
                </For>
              </Show>
            </Modal>
          )}
        </Show>
      </Match>
    </Switch>
  );
}
