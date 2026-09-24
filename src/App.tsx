import {
  Profiler,
  Suspense,
  useDeferredValue,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  useAction,
  useConvexAuth,
  useConvexConnectionState,
  useMutation,
  useQuery,
} from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  ArrowUpRight,
  Bookmark,
  Clock3,
  Download,
  ExternalLink,
  LayoutDashboard,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import * as Effect from "effect/Effect";
import { ResultsSection, Avatar } from "./ResultsSection";
import { EmailSignIn } from "./auth/EmailSignIn";
import { IMPORTS_UNAVAILABLE, OPERATOR_SIGN_IN_NOTICE } from "./integrationStatus";
import { useLiveNow } from "./library/clock";
import { useStableQuery } from "./library/stableQuery";
import { ConnectionsPanel, Dashboard, OPERATOR_BUILD, QueueTimeline } from "./operatorSurface";
import { operatorArgs } from "./operatorToken";
import { describeError } from "./errors";
import { dedupeJobsByInput, inlineImportStatus } from "./jobText";
import { JobRow } from "./JobRow";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ResultPost } from "../convex/lib/results";
import { parseQuery, type Sort } from "../convex/lib/search";
import { pushLocation, replaceLocation, useLocation } from "./locationStore";
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
import { ringAvatarUrl } from "./avatarUrl";
import { splitRing } from "./ring";

type SearchRequest = FlowSearchRequest & {
  readonly attemptId: SearchAttemptId;
  readonly trigger: SearchTrigger;
  readonly includeStats: boolean;
};

type ProfilerPhase = "mount" | "update" | "nested-update";

type ResultsProfiler = (
  id: string,
  phase: ProfilerPhase,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
) => void;

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

// A query that is only `@handle`/`from:handle` has no keywords to rank by
// relevance, so relevance ordering degenerates to whatever arbitrary order
// the index happens to return (oldest-first in practice) rather than the
// account's actual most-recent activity. `search()` below uses this to pick
// a sane default sort when the caller hasn't explicitly chosen one for this
// particular search (a real dropdown pick always wins).
function isAccountOnlyQuery(raw: string): boolean {
  try {
    const { author, text } = parseQuery(raw);

    return Boolean(author) && text.length === 0;
  } catch {
    return false;
  }
}

function Modal({
  title,
  children,
  close,
  notice,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  notice?: string;
}) {
  const titleId = useId();

  function open(node: HTMLDialogElement | null) {
    if (node && !node.open) node.showModal();
  }

  return (
    <dialog
      ref={open}
      aria-labelledby={titleId}
      onCancel={close}
      onClose={(e) => {
        if (e.nativeEvent.target === e.currentTarget) close();
      }}
      aria-modal="true"
    >
      <div className="modal-inner">
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon" onClick={close} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          {notice && <p role="status">{notice}</p>}
          {children}
        </div>
      </div>
    </dialog>
  );
}

// How much of a Web context page's plain text to show before "Show more":
// enough for a real preview, far short of the ~34k raw characters Firecrawl
// can return for a single profile page.
const WEB_CONTEXT_PREVIEW_CHARS = 2_000;

/** One source's readable preview inside the Web context modal. */
function WebContextPage({
  page,
  expanded,
  onExpand,
}: {
  page: { title: string; text: string; url: string; collectedAt: number };
  expanded: boolean;
  onExpand: () => void;
}) {
  const paragraphs = parseWebContextMarkdown(page.text);

  const { shown, truncated } = expanded
    ? { shown: paragraphs, truncated: false }
    : truncateWebContextParagraphs(paragraphs, WEB_CONTEXT_PREVIEW_CHARS);

  return (
    <div className="page-text">
      <strong>{page.title}</strong>
      <p className="muted-copy">
        Source:{" "}
        <a href={page.url} target="_blank" rel="noopener noreferrer">
          {shortenWebContextUrl(page.url, 80)}
        </a>{" "}
        · collected {new Date(page.collectedAt).toLocaleString()}
      </p>
      {shown.map((paragraph) => (
        <p key={paragraph.key}>
          {keyWebContextSegments(paragraph).map(({ key, segment }) =>
            segment.type === "link" ? (
              <a
                key={key}
                href={segment.href}
                target="_blank"
                rel="noopener noreferrer"
                title={segment.href}
              >
                {segment.label}
              </a>
            ) : (
              <span key={key}>{segment.value}</span>
            ),
          )}
        </p>
      ))}
      {truncated && (
        <button type="button" className="text-button" onClick={onExpand}>
          Show more
        </button>
      )}
    </div>
  );
}

export default function App() {
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();
  const connection = useConvexConnectionState();
  const route = useLocation();
  const [initialRoute] = useState(route);
  const [telemetry] = useState(() => createSearchTelemetryStore());
  const connectionSnapshot = connectionObservation(connection);
  const [attemptCounter, setAttemptCounter] = useState(initialRoute.version);
  const [appliedRouteVersion, setAppliedRouteVersion] = useState(route.version);

  function allocateAttempt(): number {
    const next = Math.max(attemptCounter, route.version) + 1;
    setAttemptCounter(next);

    return next;
  }

  const [draft, setDraft] = useState(initialRoute.raw),
    [raw, setRaw] = useState(initialRoute.raw),
    [sort, setSort] = useState<Sort>(initialRoute.sort),
    [statsForNerds, setStatsForNerds] = useState(initialRoute.includeStats),
    [searchRequest, setSearchRequest] = useState<SearchRequest | null>(() =>
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

  const [sessionId, setSessionId] = useState<Id<"sessions"> | null>(null);
  // Accumulated rows across pages for the current search: `search()`/
  // `retrySearch()` reset this to empty (a fresh query invalidates whatever
  // was paged in before), while `runLoadMore` appends. Kept as its own state
  // rather than derived straight from `result.rows` because a single Convex
  // session only ever holds one page — this is what lets "Load more" grow
  // the on-screen list instead of swapping it.
  const [rows, setRows] = useState<ResultPost[]>([]);
  const appendModeRef = useRef(false);
  const mergedSessionRef = useRef<Id<"sessions"> | null>(null);

  const [view, setView] = useState<ViewMode>(initialRoute.view),
    [modal, setModal] = useState<ModalKind | null>(null);

  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [accountInput, setAccountInput] = useState(""),
    [since, setSince] = useState("");

  // Job ids for imports kicked off directly from a result (Conversation /
  // Find on X). Those are real x.md fetches, not previews, so the inline
  // status line below reads live from `jobs.list` instead of just firing a
  // toast and hoping the Recent imports modal gets opened. `liveImportJob`
  // pairs the job with the query it was started for, so the status is only
  // ever shown while that's still the current query — this covers a plain
  // new search AND a route-driven query change (Back/Forward), and a
  // `runLoadLive()` that resolves late (after the query has since moved on)
  // can't resurrect an old job's status either, since the query it wrote no
  // longer matches `raw` by the time anything reads it.
  const [liveImportJob, setLiveImportJob] = useState<{
    query: string;
    jobId: Id<"jobs">;
  } | null>(null);

  const [threadJobs, setThreadJobs] = useState<Record<string, Id<"jobs">>>({});
  const pushedDashboardEntry = useRef(false);

  const [page, setPage] = useState<{
    title: string;
    text: string;
    url: string;
    collectedAt: number;
  } | null>(null);

  const [contextPages, setContextPages] = useState<
    { title: string; text: string; url: string; collectedAt: number }[] | null
  >(null);

  // Which Web context pages (by url) the reader has expanded past the
  // initial preview cap — see `WEB_CONTEXT_PREVIEW_CHARS` below.
  const [expandedContextPages, setExpandedContextPages] = useState<Set<string>>(new Set());

  const [reading, setReading] = useState(false),
    [proposal, setProposal] = useState<{
      query: string;
      explanation: string;
    } | null>(null);

  // `signIn` is memoized by ConvexAuthProvider for the provider's lifetime, so
  // capturing it once is safe. See src/sessionGate.ts for why the gate waits
  // for `isLoading` before it ever creates an anonymous session.
  const [sessionGate] = useState(() => createSessionGate(() => signIn("anonymous")));

  // Commit-phase ref callback: runs after every render with the auth values
  // of that render, so the gate always sees the latest state without an effect.
  function authProbe(node: HTMLSpanElement | null) {
    if (!node) return;
    sessionGate.update({ isLoading: authLoading, isAuthenticated });
  }

  // Both the hotkey and the footnote button (ResultsSection's
  // `onToggleStats`) go through this, so `stats=1` on the URL never drifts
  // from what's actually showing: a reload or a shared link must reproduce
  // the same on/off state, not just the query. `replaceLocation`, not
  // `pushLocation` — this is a display preference, not a navigation
  // destination, so toggling it repeatedly must not spam Back with entries
  // that only differ by `stats=`.
  const toggleStats = () => {
    const next = !statsForNerds;

    setStatsForNerds(next);
    replaceLocation({ includeStats: next });
  };

  // Effect-free global shortcut: React 19 ref callbacks may return a cleanup
  // function, which is exactly the attach/detach pair a document-level
  // listener needs — no useEffect required. Moved "Stats for nerds" off the
  // primary search row (QA report B3); "?" (outside form fields) or
  // Cmd/Ctrl+Shift+S toggles it from anywhere, matching the footnote link in
  // ResultsSection.
  function statsHotkeyRef(node: HTMLSpanElement | null) {
    if (!node) return;

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target instanceof HTMLElement ? e.target : null;

      const typing =
        !!target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) && e.key === "?";

      if (typing) return;

      const isToggle =
        e.key === "?" || ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s");

      if (!isToggle) return;
      e.preventDefault();
      toggleStats();
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }

  const ensureSession = sessionGate.ensure;

  if (route.version !== appliedRouteVersion) {
    setAppliedRouteVersion(route.version);
    setAttemptCounter((count) => Math.max(count, route.version));

    const queryChanged =
      route.raw !== raw || route.sort !== sort || route.includeStats !== statsForNerds;

    if (queryChanged) {
      setRaw(route.raw);
      setDraft(route.raw);
      setSort(route.sort);
      setStatsForNerds(route.includeStats);
      setSessionId(null);
      // `appendModeRef` is deliberately left untouched here: it's only
      // consulted once new rows land, at which point `rows` is already `[]`
      // (below), so "append to nothing" and "replace" produce the same
      // result — no ref mutation needed during render.
      setRows([]);
      setSearchRequest(
        route.raw.trim()
          ? {
              raw: route.raw,
              sort: route.sort,
              includeStats: route.includeStats,
              attemptId: route.version,
              trigger: SearchTrigger.InitialUrl,
            }
          : null,
      );
      // Use route.view, not a hardcoded Search: a query change from
      // Back/Forward can land on a URL that still carries `?view=bookmarks`
      // (e.g. the user was on `/?q=a&view=bookmarks`, searched `b`, then
      // pressed Back to `/?q=a&view=bookmarks` again), and `parseUrl`
      // already defaults to Search when the URL has no `view` at all — so
      // this is never less correct than hardcoding it.
      setView(route.view);
      setProposal(null);
    } else if (route.view !== view) {
      // Same query, only the view changed underneath it — e.g. Back/Forward
      // across a `?view=bookmarks` toggle. A real query change (above)
      // already forces the search view, so this only ever fires for that
      // narrower case.
      setView(route.view);
    }
  }

  // The operator build opens at the dashboard by default (the operator URL
  // IS the dashboard — docs/production.md): `?search=1` is what asks for
  // the search view instead, so `route.dashboard` (the public build's own
  // `?dashboard=1`, which still does nothing there) is inverted around
  // `route.search` here rather than read directly. A URL that already
  // carries a query (`?q=...`) also lands on search without needing
  // `search=1` too, so a shared/bookmarked search link keeps working on the
  // operator site instead of being swallowed by the new default. The public
  // build never has `OPERATOR_BUILD` true, so this always falls through to
  // the original, unswapped behavior there.
  const dashboard = OPERATOR_BUILD ? !route.search && !route.raw : route.dashboard;
  const queue = route.queue;
  const accountResults = useQuery(api.search.accounts);
  const accounts = accountResults ?? [];
  // `configured.indexing` decays with real time (worker liveness), not only
  // when the underlying row changes — convex/integrations.ts requires `now`
  // for exactly the reason convex/summary.ts's queries do (a query re-runs
  // on a document write, never merely because time passed). `useLiveNow`,
  // not the bucketed `useDashboardClock`: this feeds convex/worker.ts's
  // tight 45s `isWorkerLive` window, which a rounded `now` corrupts in
  // either rounding direction (see that hook's comment).
  const now = useLiveNow();
  // `useStableQuery`, not `useQuery`: `now` ticks every 5s, and a bare
  // `useQuery` reports `undefined` on every argument change until the new
  // result lands, which put the whole page back into "Loading the search
  // library…" on each tick.
  const configured = useStableQuery(api.integrations.configured, { now });
  const libraryLoading = accountResults === undefined || configured === undefined;
  // The caller's own identity (convex/auth.ts `me`) — never a client-supplied
  // id. `verifiedEmail` narrows straight to the one address `email.send` will
  // ever accept (it requires an exact, case-insensitive match against the
  // signed-in identity's own verified email — convex/email.ts `send`), so
  // there is nothing to type or get wrong at send time.
  const me = useQuery(api.auth.me);
  const verifiedEmail = me?.emailVerified ? (me.email ?? null) : null;
  // Provider-spending actions (starting/retrying an import, web context,
  // "Help me search", Find on X, Conversation) require a signed-in
  // OPERATOR — convex/access.ts `requireOperator` — not merely a signed-in
  // guest. This is only used to show the sign-in path before someone hits
  // the server's ConvexError; the server enforces the boundary regardless
  // of what this reads.
  // `undefined` while loading: gated actions stay disabled, but the sign-in
  // notice waits for a confirmed `false` so an operator never sees it flash.
  const isOperator = useQuery(api.access.isOperator, isAuthenticated ? operatorArgs() : "skip");

  let queryError = "";

  try {
    parseQuery(raw);
  } catch (e) {
    // SAFETY: `parseQuery` (convex/lib/search.ts) only ever throws `new
    // Error(...)`, never a non-Error value.
    queryError = (e as Error).message;
  }

  const snapshot = useQuery(
    api.search.results,
    sessionId && isAuthenticated ? { sessionId } : "skip",
  );

  const result =
    snapshot?._id === sessionId && snapshot.raw === raw && snapshot.sort === sort
      ? snapshot
      : undefined;

  const jobs = useQuery(api.jobs.list, isAuthenticated ? {} : "skip")?.jobs ?? [];
  const saved = useQuery(api.search.saved, isAuthenticated ? {} : "skip") ?? [];
  const bookmarks = useQuery(api.search.bookmarks, isAuthenticated ? {} : "skip") ?? [];
  const deliveries = useQuery(api.email.deliveries, isAuthenticated ? {} : "skip") ?? [];

  // Read-only digest preview (convex/email.ts `preview`) — lets the modal
  // show exactly what `send` would deliver before the user commits. Only
  // queried while the email modal is actually open and there is a completed
  // session to preview.
  const emailPreview = useQuery(
    api.email.preview,
    modal === ModalKind.Email && sessionId && isAuthenticated ? { sessionId } : "skip",
  );

  const startSearch = useMutation(api.search.start);

  const start = useMutation(api.jobs.start),
    retry = useMutation(api.jobs.retry),
    cancelJob = useMutation(api.jobs.cancel),
    dismissInput = useMutation(api.jobs.dismissInput),
    bookmark = useMutation(api.search.bookmark),
    save = useMutation(api.search.save),
    removeSaved = useMutation(api.search.removeSaved),
    send = useMutation(api.email.send);

  const webContext = useAction(api.integrations.webContext);

  const readLink = useAction(api.integrations.readLink),
    interpret = useAction(api.integrations.interpret);

  const telemetrySnapshot = useSyncExternalStore(
    telemetry.subscribe,
    telemetry.getSnapshot,
    telemetry.getServerSnapshot,
  );

  const activeFrontendStats =
    telemetrySnapshot && telemetrySnapshot.attemptId === searchRequest?.attemptId
      ? telemetrySnapshot
      : null;

  const deferredFrontendStats = useDeferredValue(activeFrontendStats);
  const [isSearchPending, startSearchTransition] = useTransition();
  // Written only from event handlers and commit-phase ref callbacks, read only
  // from async continuations — never touched during render.
  const latestAttempt = useRef<number | null>(null);
  const kickedAttempt = useRef<number | null>(null);
  // Which attempt's session is actually confirmed (`markSession` has run for
  // it). `runLoadMore` starts a new attempt but deliberately leaves the OLD
  // session in `sessionId` until the new page resolves (see its comment) —
  // without this guard, `resultsCommitRef`/`onResultsRender` below would
  // read that stale `result` (still keyed by the old session) as if it
  // belonged to the new attempt, mark it terminal early, and then ignore
  // the real completion once the new page actually lands (`commitResult`
  // never re-marks a terminal attempt).
  const sessionAttemptRef = useRef<number | null>(null);

  function runSearch(request: SearchRequest): boolean {
    telemetry.startAttempt({
      attemptId: request.attemptId,
      trigger: request.trigger,
      connection: connectionSnapshot,
    });

    if (!configured?.search || queryError) return false;
    latestAttempt.current = request.attemptId;
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
        if (latestAttempt.current !== request.attemptId) return;

        if (telemetry.markSession(request.attemptId, id, connectionSnapshot))
          sessionAttemptRef.current = request.attemptId;
        setSessionId(id);
        setBusy(false);
      },
      (cause: unknown) => {
        if (latestAttempt.current !== request.attemptId) return;
        setNotice(describeError(cause));
        setBusy(false);
      },
    );

    return true;
  }

  // Effect-free search kick: this ref callback re-runs on every commit (plain
  // function identity), so it picks up the initial request and later route
  // changes without any useEffect. Popstate itself is covered by
  // locationStore's useSyncExternalStore subscription.
  function kickPendingRef(node: HTMLElement | null) {
    if (node === null) return;

    if (searchRequest !== null && kickedAttempt.current !== searchRequest.attemptId) {
      if (runSearch(searchRequest)) kickedAttempt.current = searchRequest.attemptId;
    }

    // Fold a freshly-landed page into `rows` at commit time (same
    // no-useEffect trick as the kick above): once this session's rows are
    // in, "Load more" (append) or a new search (replace, see `search()`/
    // route sync) decides how they combine with what's already on screen.
    if (
      result &&
      result._id === sessionId &&
      result.status === "complete" &&
      mergedSessionRef.current !== result._id
    ) {
      mergedSessionRef.current = result._id;
      setRows((prev) =>
        mergeSearchPages(prev, result.rows, appendModeRef.current ? "append" : "replace"),
      );
    }
  }

  // Commit-phase telemetry: Profiler onRender (no useEffect) records render cost,
  // and the results ref below records first/terminal commits when Convex data lands.
  const onResultsRender: ResultsProfiler = (_id, _phase, actualDuration, baseDuration) => {
    const attempt = searchRequest?.attemptId;

    if (attempt !== undefined && sessionAttemptRef.current === attempt)
      telemetry.recordProfiler(attempt, actualDuration, baseDuration);
  };

  function resultsCommitRef(node: HTMLElement | null) {
    const req = searchRequest;

    if (!node || !req || !result || result._id !== sessionId) return;

    // Guards against a stale `result` (still keyed by a session from before
    // `runLoadMore` started a new attempt) being read as if it belonged to
    // that new attempt — see `sessionAttemptRef`'s declaration above.
    if (sessionAttemptRef.current !== req.attemptId) return;

    if (result.status === "complete" || result.status === "failed") {
      telemetry.markTerminal({
        attemptId: req.attemptId,
        status: result.status === "complete" ? SearchStatus.Complete : SearchStatus.Failed,
        rowCount: result.rows.length,
        sessionId: result._id,
        connection: connectionSnapshot,
      });
    } else {
      telemetry.markResultCommit({
        attemptId: req.attemptId,
        status: result.status === "running" ? SearchStatus.Running : SearchStatus.Queued,
        rowCount: result.rows.length,
        sessionId: result._id,
        connection: connectionSnapshot,
      });
    }
  }

  // NB: `task` is deliberately a plain void function: it only ever runs in
  // event handlers, so the closure it needs is the one formed per render.
  // Outcome handling lives in the module-level runTask helper, keeping
  // try/finally syntax (which this React Compiler build cannot compile) out
  // of the component.
  function task(work: Promise<unknown>, success?: string, onSettled?: () => void): void {
    setNotice("");
    setBusy(true);
    runTask(() => work, {
      onSuccess: () => {
        if (success !== undefined) setNotice(success);
      },
      onError: (e) => setNotice(describeError(e)),
      onSettled: () => {
        setBusy(false);
        onSettled?.();
      },
    });
  }

  // Event-handler bodies, kept out of the JSX so the async state updates they
  // perform are plain functions instead of inline-updater closures.
  const submitImport = async () => {
    await ensureSession();
    await start({
      kind: "bulk",
      input: accountInput,
      since: since || undefined,
      ...operatorArgs(),
    });
    setAccountInput("");
  };

  const runLoadLive = async () => {
    await ensureSession();
    const query = raw;

    const jobId = await start({
      kind: "live",
      input: query.replace(/(^|\s)@([\w]+)/g, "$1from:$2"),
      ...operatorArgs(),
    });

    setLiveImportJob({ query, jobId });
  };

  const runRead = async (url: string) => {
    await ensureSession();
    setPage(await readLink({ url, ...operatorArgs() }));
  };

  const proposeSearch = async () => {
    await ensureSession();
    setProposal(await interpret({ raw: draft, ...operatorArgs() }));
  };

  const runWebContext = async () => {
    await ensureSession();
    setContextPages(await webContext({ query: raw, ...operatorArgs() }));
    setExpandedContextPages(new Set());
  };

  const runThread = async (post: ResultPost) => {
    await ensureSession();
    const jobId = await start({ kind: "post", input: post.url, ...operatorArgs() });
    setThreadJobs((prev) => ({ ...prev, [post.tweetId]: jobId }));
  };

  const runLoadMore = () => {
    if (!result?.nextCursor) return;
    appendModeRef.current = true;
    // Its own telemetry attempt (trigger `NextPage`), not a continuation of
    // the first page's: `runSearch` starts a fresh one below, so the "Stats
    // for nerds" panel times *this* cursor request instead of freezing on
    // whatever the first page measured (its attempt already reached a
    // terminal state, so further commits for it are ignored — see
    // `searchTelemetry.ts` `commitResult`'s `terminalCommitAt` guard).
    const attemptId = allocateAttempt();

    const request: SearchRequest = {
      raw,
      sort,
      cursor: result.nextCursor,
      includeStats: result.includeStats === true,
      attemptId,
      trigger: SearchTrigger.NextPage,
    };

    // No scrollTo: "Load more" appends to the current list, so the reader's
    // place in what they've already read is preserved (see
    // `kickPendingRef`'s merge into `rows`, which is what actually makes
    // the append visible once this page's rows land). `sessionId` is left
    // alone until the new page resolves, so the list on screen doesn't blip
    // to a loading state while it fetches.
    setSearchRequest(request);
    startSearchTransition(() => {
      if (runSearch(request)) kickedAttempt.current = request.attemptId;
    });
  };

  const runSave = async () => {
    await ensureSession();
    await save({ raw, sort });
  };

  const runBookmark = async (post: ResultPost) => {
    await ensureSession();
    await bookmark({ tweetId: post.tweetId, sessionId: sessionId ?? undefined });
  };

  const runRemoveSaved = async (id: Id<"saved">) => {
    await removeSaved({ id });
  };

  const importAccount = (e: FormEvent) => {
    e.preventDefault();
    void task(submitImport(), "Import started. You'll see its progress in Recent imports.");
  };

  // The inline status line already says the fetch is running (see the
  // "Import from X" toolbar button below), so there's nothing left for the
  // dismissible top notice to add here.
  const loadLive = () => void task(runLoadLive());

  const read = (url: string) => {
    setReading(true);
    task(runRead(url), undefined, () => setReading(false));
  };

  const deferredRaw = useDeferredValue(raw);
  const visible = view === ViewMode.Bookmarks ? bookmarks : rows;
  const home = !deferredRaw && view === ViewMode.Search;

  // The ring only has room for ~32 avatars before they overlap. Past that,
  // account 33+ used to silently vanish with no indication more existed
  // (QA report P3). Reserve the last ring slot for a "+N more" chip instead
  // of a 33rd avatar, so nothing is dropped without a way to reach it (the
  // chip opens ModalKind.AllAccounts, a plain scrollable list of everyone).
  // Drives the "Save search" -> "Saved" label (QA report A12): looked up by
  // the exact query+sort pair, since convex/search.ts:save treats those as
  // distinct saved entries (see src/sortOptions.ts's sortLabel, added for
  // the same reason in the Saved searches modal). `isAlreadySaved` trims
  // `raw` before comparing — see its own comment for why.
  const alreadySaved = isAlreadySaved(saved, raw, sort);
  const RING_LIMIT = 32;
  const { shown: ringAccounts, overflow: ringOverflow } = splitRing(accounts, RING_LIMIT);

  const openDashboard = () => {
    if (!OPERATOR_BUILD) return;
    setModal(null);
    pushedDashboardEntry.current = true;
    // Drop `q`/the search query from the URL the dashboard entry carries:
    // it's a leftover from whatever page the user was on, not a dashboard
    // param, and showing up there is confusing on reload/share (see close()
    // below for the matching Back-button fix). Clearing `search` is what
    // gets back to the dashboard now that it's the operator build's
    // default at `/` — see the `dashboard` inversion above.
    pushLocation({ search: false, raw: "" });
  };

  const search = (query: string, nextSort?: Sort) => {
    const trimmed = query.trim();
    const effectiveSort = nextSort ?? (isAccountOnlyQuery(trimmed) ? "newest" : sort);
    appendModeRef.current = false;
    // No explicit liveImportJob reset needed here: its query is compared
    // against `raw` at the point of use (below), so a stale job from a
    // previous query is never shown once `raw` has moved on — see the
    // `liveImportJob` declaration above for why that also covers
    // route-driven changes and a late-resolving `runLoadLive()`.
    const attemptId = allocateAttempt();

    const request: SearchRequest = {
      raw: trimmed,
      sort: effectiveSort,
      includeStats: statsForNerds,
      attemptId,
      trigger: SearchTrigger.Submit,
    };

    setRaw(trimmed);
    setDraft(trimmed);
    setSort(effectiveSort);
    setSessionId(null);
    setRows([]);
    setSearchRequest(request);
    setView(ViewMode.Search);
    setProposal(null);

    // CodeRabbit #4090910231: the operator build's own pushLocation also
    // pins `search: true`. Without it, clearing the query mid-session (e.g.
    // the wordmark's `search("")`) could drop both `q=` and `search=1` from
    // the URL at once, which the `dashboard` inversion above reads as "back
    // to the default" and bounces to the dashboard instead of staying on the
    // now-empty search view a person just asked to see. Left off the public
    // build's own URLs entirely, where `search` means nothing and would
    // just be clutter — hence two full object literals rather than one
    // conditionally-spread field.
    if (OPERATOR_BUILD)
      pushLocation({
        raw: trimmed,
        sort: effectiveSort,
        includeStats: statsForNerds,
        view: ViewMode.Search,
        search: true,
      });
    else
      pushLocation({
        raw: trimmed,
        sort: effectiveSort,
        includeStats: statsForNerds,
        view: ViewMode.Search,
      });
    startSearchTransition(() => {
      if (runSearch(request)) kickedAttempt.current = request.attemptId;
    });
  };

  const retrySearch = () => {
    const attemptId = allocateAttempt();

    const request: SearchRequest = {
      raw,
      sort,
      includeStats: statsForNerds,
      attemptId,
      trigger: SearchTrigger.Retry,
    };

    appendModeRef.current = false;
    setSessionId(null);
    setRows([]);
    setSearchRequest(request);
    startSearchTransition(() => {
      if (runSearch(request)) kickedAttempt.current = request.attemptId;
    });
  };

  // QA report A14: any other path (e.g. a typo'd shared link) used to
  // render the full home page with a 200, hiding the mistake. This app has
  // no path-based routes — dashboard/search/etc. are all query params on
  // "/" — so anything else really is unknown.
  if (route.path !== "/") {
    return (
      <div className="app not-found">
        <span ref={authProbe} hidden />
        <h1>Page not found</h1>
        <p>There's nothing at this address.</p>
        {/* The operator build's own `/` opens the dashboard, not search
            (see the `dashboard` inversion below), so this needs
            `?search=1` to land where its label says. */}
        <a href={OPERATOR_BUILD ? "/?search=1" : "/"}>Back to search</a>
      </div>
    );
  }

  // Checked BEFORE `dashboard`: Dashboard's own "Queue" nav link
  // (src/Dashboard.tsx) navigates by setting `queue=1` without touching
  // `search`/`raw`, so a URL that would otherwise resolve to the dashboard
  // (see the `dashboard` inversion above) plus `queue=1` means "on the Queue
  // page, reached from the dashboard" — the Queue branch must win that URL,
  // not Dashboard's.
  if (OPERATOR_BUILD && queue && QueueTimeline)
    return (
      <Suspense fallback={null}>
        <span ref={authProbe} hidden />
        <QueueTimeline
          close={() => {
            // Unlike `openDashboard` below, nothing here pushes a dedicated
            // history entry to reach `?queue=1` — the only entry points are
            // a direct link/reload and Dashboard's "Queue" nav link, above.
            // Clearing just the `queue` flag in place is therefore always
            // the right undo: it falls back to the Dashboard page when this
            // was reached from there (the URL still resolves `dashboard` to
            // true — see the inversion above), and to plain search otherwise.
            replaceLocation({ queue: false });
          }}
        />
      </Suspense>
    );

  if (OPERATOR_BUILD && dashboard && Dashboard)
    return (
      <Suspense fallback={null}>
        <span ref={authProbe} hidden />
        <Dashboard
          ensureSession={ensureSession}
          close={() => {
            // `openDashboard` pushed exactly one history entry to get here,
            // so undo it with a real Back instead of rewriting this entry
            // in place — that's what actually lands back on the page the
            // user came from rather than skipping it on a later Back press.
            // A direct link/reload into the dashboard (the operator build's
            // own default at `/`) never pushed that entry, so there is
            // nothing to go back to; fall back to setting `search` on the
            // current entry instead.
            if (pushedDashboardEntry.current) {
              pushedDashboardEntry.current = false;
              window.history.back();
            } else {
              replaceLocation({ search: true });
            }
          }}
        />
      </Suspense>
    );

  return (
    <div className={`app ${home ? "is-home" : "has-results"}`}>
      <span ref={authProbe} hidden />
      <span ref={statsHotkeyRef} hidden />
      <header className="topbar">
        <button
          type="button"
          className="wordmark"
          onClick={() => search("")}
          aria-label="Xearch home"
        >
          xearch<span className="wordmark-dot">.</span>
        </button>
        <nav aria-label="Main navigation">
          {OPERATOR_BUILD && (
            <button type="button" aria-label="Import dashboard" onClick={openDashboard}>
              <LayoutDashboard size={15} />
              <span>Dashboard</span>
            </button>
          )}
          <button
            type="button"
            aria-label="Saved searches"
            onClick={() => {
              setModal(ModalKind.Saved);
            }}
          >
            <Clock3 size={15} />
            <span>Saved searches</span>
          </button>
          <button
            type="button"
            aria-label="Bookmarks"
            aria-pressed={view === ViewMode.Bookmarks}
            onClick={() => {
              const nextView = view === ViewMode.Bookmarks ? ViewMode.Search : ViewMode.Bookmarks;
              setView(nextView);
              // Carry the current `statsForNerds` value along: the "Stats
              // for nerds" checkbox never itself pushes a location, so if
              // it drifted from the URL's `stats` param, leaving it out
              // here would make the next route sync see includeStats as
              // "changed" — misreading this view toggle as a query change,
              // which resets rows/session and reverts the checkbox.
              pushLocation({ view: nextView, includeStats: statsForNerds });
            }}
          >
            <Bookmark size={15} />
            <span>Bookmarks</span>
            {bookmarks.length > 0 && <small>{bookmarks.length}</small>}
          </button>
          <button
            type="button"
            aria-label="Import account"
            className="import-nav"
            onClick={() => setModal(ModalKind.Imports)}
          >
            <Plus size={16} />
            <span>Import account</span>
          </button>
        </nav>
      </header>
      {!connection.isWebSocketConnected && (
        <p className="connection" role="status">
          <span className="connection-dot" />
          {connection.hasEverConnected
            ? "Reconnecting to the search library…"
            : "Connecting to the search library…"}
        </p>
      )}
      <main ref={kickPendingRef}>
        <section className="search-stage" aria-label="Search X posts">
          {home && (
            <>
              <div className="orbit" role="group" aria-label="Imported accounts">
                {ringAccounts.map((a, i) => {
                  const slots = ringAccounts.length + (ringOverflow > 0 ? 1 : 0);
                  const angle = (i / slots) * Math.PI * 2 - Math.PI / 2;

                  return (
                    <button
                      type="button"
                      title={`Search @${a.handle}`}
                      aria-label={`Search @${a.handle}`}
                      key={a._id}
                      style={
                        // SAFETY: CSSProperties has no index signature for
                        // custom properties, but `--left`/`--top` are consumed
                        // only by this component's own stylesheet.
                        {
                          "--left": `${50 + 44 * Math.cos(angle)}%`,
                          "--top": `${50 + 45 * Math.sin(angle)}%`,
                        } as CSSProperties
                      }
                      onClick={() => search(`@${a.handle}`)}
                    >
                      <Avatar name={a.handle} url={ringAvatarUrl(a.avatar)} />
                    </button>
                  );
                })}
                {ringOverflow > 0 &&
                  (() => {
                    const slots = ringAccounts.length + 1;
                    const angle = (ringAccounts.length / slots) * Math.PI * 2 - Math.PI / 2;

                    return (
                      <button
                        type="button"
                        className="orbit-more"
                        title={`${ringOverflow} more accounts`}
                        aria-label={`Show ${ringOverflow} more imported accounts`}
                        style={
                          // SAFETY: CSSProperties has no index signature for
                          // custom properties, but `--left`/`--top` are
                          // consumed only by this component's own stylesheet.
                          {
                            "--left": `${50 + 44 * Math.cos(angle)}%`,
                            "--top": `${50 + 45 * Math.sin(angle)}%`,
                          } as CSSProperties
                        }
                        onClick={() => setModal(ModalKind.AllAccounts)}
                      >
                        +{ringOverflow}
                      </button>
                    );
                  })()}
              </div>
              {accounts.length > 0 && (
                <div className="account-strip" role="group" aria-label="Imported accounts">
                  {accounts.map((a) => (
                    <button
                      type="button"
                      title={`Search @${a.handle}`}
                      aria-label={`Search @${a.handle}`}
                      key={a._id}
                      onClick={() => search(`@${a.handle}`)}
                    >
                      <Avatar name={a.handle} url={ringAvatarUrl(a.avatar)} />
                    </button>
                  ))}
                </div>
              )}
              <div className="hero-title">
                <p>Every indexed account, one search.</p>
                <h1>Search X posts.</h1>
              </div>
            </>
          )}
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();

              if (draft.trim()) search(draft);
            }}
          >
            <label htmlFor="query">Search posts</label>
            <div className="search-controls">
              <div className="query-wrap">
                <Search size={19} />
                <input
                  id="query"
                  name="query"
                  type="search"
                  maxLength={300}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="e.g. local-first software or @handle"
                  autoComplete="off"
                  list="accounts"
                />
                <datalist id="accounts">
                  {accounts.map((a) => (
                    <option key={a._id} value={`@${a.handle}`}>
                      {a.name}
                    </option>
                  ))}
                </datalist>
              </div>
              <select
                aria-label="Sort results"
                value={sort}
                onChange={(e) => {
                  // SAFETY: every <option> below comes from `sorts`, whose
                  // `value`s are typed `Sort`, so the <select>'s string
                  // value is always one of them.
                  const nextSort = e.target.value as Sort;
                  const query = sortChangeQuery(draft, raw);

                  if (query !== null) search(query, nextSort);
                  else setSort(nextSort);
                }}
              >
                {sorts.map((s) => (
                  <option value={s.value} key={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button type="submit" className="primary" disabled={!draft.trim()}>
                Search
              </button>
            </div>
            <div className="search-help">
              <span>
                Search everything, select a creator, or start with <b>@</b> to filter by account.
              </span>
              {configured?.openai && (
                <>
                  <button
                    type="button"
                    className="text-button ai"
                    disabled={busy || !draft.trim() || !isOperator}
                    title={isOperator ? "Suggest a clearer search" : undefined}
                    onClick={() => void task(proposeSearch())}
                  >
                    <Sparkles size={13} />
                    Help me search
                  </button>
                  {/* A disabled `title` alone is unreliable for keyboard/touch
                      users (CodeRabbit #4089730724) — the reason is also shown
                      as visible text. */}
                  {isOperator === false && (
                    <span className="config-warning">{OPERATOR_SIGN_IN_NOTICE}</span>
                  )}
                </>
              )}
            </div>
          </form>
          {proposal && (
            <div className="proposal">
              <div>
                <strong>{proposal.query}</strong>
                <p>{proposal.explanation}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDraft(proposal.query);
                  setProposal(null);
                  document.getElementById("query")?.focus();
                }}
              >
                Use this query
              </button>
            </div>
          )}
          {/* When accounts exist, the search-help line above ("Search
              everything, select a creator, or start with @...") already
              says everything this status line used to — a second line
              telling people to "select an account" contradicted it by
              implying that step was required. Only show a status line for
              the two states search-help doesn't cover: still loading, or
              nothing to search yet. */}
          {home && libraryLoading ? (
            <div className="library-status" aria-live="polite">
              <span className="status-dot loading" />
              Loading the search library…
            </div>
          ) : home && !accounts.length ? (
            <div className="library-status" aria-live="polite">
              <span className="status-dot muted" />
              No accounts have been imported yet. Import an account to add account history.
              <button
                type="button"
                className="text-button"
                onClick={() => setModal(ModalKind.Imports)}
              >
                Import an account <Plus size={13} />
              </button>
            </div>
          ) : null}
        </section>
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button
              type="button"
              className="icon"
              aria-label="Dismiss message"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {reading && (
          <div className="notice" role="status">
            Reading the linked page…
          </div>
        )}
        {!home && (
          <Profiler id="results" onRender={onResultsRender}>
            <div ref={resultsCommitRef}>
              <ResultsSection
                view={view}
                raw={raw}
                configured={configured}
                result={result}
                queryError={queryError}
                visible={visible}
                bookmarkedIds={new Set(bookmarks.map((b) => b.tweetId))}
                busy={busy}
                onSearch={search}
                onSave={() => void task(runSave(), "Search saved.")}
                onLiveSearch={loadLive}
                onOpenModal={(which) => setModal(which)}
                onRetry={retrySearch}
                onWebContext={runWebContext}
                onLoadMore={runLoadMore}
                onRead={read}
                onBookmark={(post) => void task(runBookmark(post))}
                onThread={(post) => void task(runThread(post))}
                liveImportStatus={
                  liveImportJob && liveImportJob.query === raw
                    ? inlineImportStatus(jobs.find((j) => j._id === liveImportJob.jobId))
                    : null
                }
                threadStatus={(tweetId) =>
                  inlineImportStatus(jobs.find((j) => j._id === threadJobs[tweetId]))
                }
                frontendStats={deferredFrontendStats}
                searchPending={isSearchPending}
                emailNeedsSignIn={!verifiedEmail}
                statsForNerds={statsForNerds}
                onToggleStats={toggleStats}
                alreadySaved={alreadySaved}
                isOperator={isOperator}
              />
            </div>
          </Profiler>
        )}
      </main>
      <footer className="site-footer">
        <span>Find the words. Keep the context.</span>
        <div>
          <a href="https://mdfromx.com" target="_blank" rel="noreferrer">
            Powered by x.md <ArrowUpRight size={12} />
          </a>
          {OPERATOR_BUILD && (
            <button type="button" onClick={() => setModal(ModalKind.Setup)}>
              <SlidersHorizontal size={13} />
              Connections
            </button>
          )}
        </div>
      </footer>
      {modal === ModalKind.Imports && (
        <Modal notice={notice} title="Import an account" close={() => setModal(null)}>
          <p className="muted-copy">
            Collect an account's public history from X. You'll see its progress below.
          </p>
          {isAuthenticated && isOperator === false && (
            <p className="config-warning">{OPERATOR_SIGN_IN_NOTICE}</p>
          )}
          <form className="stack-form" onSubmit={importAccount}>
            <label htmlFor="account">X handle</label>
            <input
              id="account"
              value={accountInput}
              onChange={(e) => setAccountInput(e.target.value)}
              placeholder="@handle"
              required
              maxLength={16}
            />
            <label htmlFor="since">
              History since <small>Optional, YYYY-MM-DD</small>
            </label>
            <input
              id="since"
              inputMode="numeric"
              pattern="\d{4}-\d{2}-\d{2}"
              placeholder="YYYY-MM-DD"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
            <button
              className="primary"
              type="submit"
              disabled={busy || !configured?.indexing || !isOperator}
            >
              <Download size={16} />
              Import posts
            </button>
            {configured && !configured.indexing && (
              <p className="config-warning">{IMPORTS_UNAVAILABLE}</p>
            )}
            {OPERATOR_BUILD && (
              <button type="button" className="text-button" onClick={openDashboard}>
                More options in the dashboard <ArrowUpRight size={13} />
              </button>
            )}
          </form>
          <div className="jobs">
            <h3>Recent imports</h3>
            {!jobs.length && (
              <p className="muted-copy">Your imports and their progress will appear here.</p>
            )}
            {/* Repeat runs of the exact same input (e.g. every past click of
                "Retry" before convex/jobs.ts grew an in-place retry mutation)
                fold into one row — see dedupeJobsByInput's own comment. */}
            {dedupeJobsByInput(jobs).map(({ job, earlierCount }) => (
              <JobRow
                key={job._id}
                job={job}
                now={now}
                earlierCount={earlierCount}
                isOperator={isOperator}
                onCancel={async (j) => {
                  await ensureSession();
                  await cancelJob({ jobId: j._id, ...operatorArgs() });
                }}
                // An import runs to the end of what the provider has on its
                // own (convex/jobs.ts `finish` continues and retries by
                // itself), so the only thing left for a person is to resume
                // a run that gave up for good. That resumes THIS job where
                // it stopped — never a new job from its cursor.
                onRetry={async (j) => {
                  await ensureSession();
                  await retry({ jobId: j._id, ...operatorArgs() });
                }}
                // Dismiss the WHOLE folded group, not just the one visible
                // row: `jobs.dismissInput` walks every job for this exact
                // (kind, input) server-side, so it isn't limited to whatever
                // page `jobs.list` happened to hand this component (see its
                // own comment in convex/jobs.ts for why a client-side id
                // list isn't enough once a group has 21+ runs in it).
                onDismiss={async (j) => {
                  await ensureSession();
                  await dismissInput({ kind: j.kind, input: j.input, ...operatorArgs() });
                }}
              />
            ))}
          </div>
        </Modal>
      )}
      {modal === ModalKind.Saved && (
        <Modal title="Saved searches" close={() => setModal(null)}>
          <p className="muted-copy">Saved privately to this browser's guest session.</p>
          {!saved.length && (
            <div className="empty small">
              <Clock3 size={26} />
              <p>Run a search, then save it to come back to it.</p>
            </div>
          )}
          {saved.map((item) => (
            <div className="saved-row" key={item._id}>
              <button
                type="button"
                onClick={() => {
                  search(item.query, item.sort);
                  setModal(null);
                }}
              >
                <Search size={16} />
                {item.query}
                <small>{sortLabel(item.sort)}</small>
              </button>
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${item.query}`}
                onClick={() => void task(runRemoveSaved(item._id))}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </Modal>
      )}
      {modal === ModalKind.Email && (
        <Modal notice={notice} title="Email these results" close={() => setModal(null)}>
          {me === undefined ? (
            <p className="muted-copy">Checking your account…</p>
          ) : !verifiedEmail ? (
            <>
              <p className="muted-copy">
                Sending requires a verified email address, so results only ever go to you. Search
                and every other feature stay available without one.
              </p>
              <EmailSignIn
                className="stack-form"
                onSignedIn={() => setNotice("Signed in. You can now preview and send this digest.")}
              />
            </>
          ) : (
            <>
              <p className="muted-copy">
                {emailPreview
                  ? `First ${emailPreview.rowCount} of ${emailPreview.totalCount} results for "${raw}", with original post links.`
                  : `Send the first 10 matches for "${raw}", with original post links.`}{" "}
                Sending happens only when you press the button below.
              </p>
              {emailPreview && <p className="muted-copy">Subject: {emailPreview.subject}</p>}
              <form
                className="stack-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void task(
                    (async () => {
                      await ensureSession();
                      await send({ sessionId: sessionId!, recipient: verifiedEmail });
                    })(),
                    "Email queued. Delivery status appears below.",
                  );
                }}
              >
                <p>
                  Sends to your verified address: <strong>{verifiedEmail}</strong>
                </p>
                <button className="primary" type="submit" disabled={busy || !sessionId}>
                  Send results
                </button>
              </form>
            </>
          )}
          {deliveries.map((d) => (
            <p key={d._id} className="delivery">
              {d.query}: {d.delivery?.status ?? "unknown"}
            </p>
          ))}
        </Modal>
      )}
      {OPERATOR_BUILD && modal === ModalKind.Setup && ConnectionsPanel && (
        <Modal notice={notice} title="Connections" close={() => setModal(null)}>
          <ConnectionsPanel />
        </Modal>
      )}
      {modal === ModalKind.AllAccounts && (
        <Modal title="All imported accounts" close={() => setModal(null)}>
          <div className="account-list">
            {accounts.map((a) => (
              <button
                type="button"
                className="account-list-row"
                key={a._id}
                onClick={() => {
                  setModal(null);
                  search(`@${a.handle}`);
                }}
              >
                <Avatar name={a.handle} url={ringAvatarUrl(a.avatar)} />
                <span>@{a.handle}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {page && (
        <Modal title={page.title} close={() => setPage(null)}>
          <p className="muted-copy">Collected {new Date(page.collectedAt).toLocaleString()}</p>
          <p className="page-text">{page.text}</p>
          <a href={page.url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            Open original page
          </a>
        </Modal>
      )}
      {contextPages &&
        (contextPages.length ? (
          <Modal title="Web context" close={() => setContextPages(null)}>
            {contextPages.map((p) => (
              <WebContextPage
                key={p.url}
                page={p}
                expanded={expandedContextPages.has(p.url)}
                onExpand={() => setExpandedContextPages((prev) => new Set(prev).add(p.url))}
              />
            ))}
          </Modal>
        ) : (
          <Modal title="Web context" close={() => setContextPages(null)}>
            <p className="muted-copy">No linked pages found for this search.</p>
          </Modal>
        ))}
    </div>
  );
}
