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
import { IMPORTS_UNAVAILABLE } from "./integrationStatus";
import { useDashboardNow } from "./library/clock";
import { ConnectionsPanel, Dashboard, OPERATOR_BUILD } from "./operatorSurface";
import { describeError } from "./errors";
import { jobLabel, jobSummary, jobWarnings } from "./jobText";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ResultPost } from "../convex/lib/results";
import { parseQuery, type Sort } from "../convex/lib/search";
import { pushLocation, replaceLocation, useLocation } from "./locationStore";
import { runTask } from "./runTask";
import { searchFlow, type SearchRequest as FlowSearchRequest } from "./searchFlow";
import { createSessionGate } from "./sessionGate";
import {
  createSearchTelemetryStore,
  SearchStatus,
  SearchTrigger,
  type ConvexConnectionState,
  type SearchAttemptId,
} from "./searchTelemetry";
import { ModalKind, ViewMode } from "./uiState";

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

const sorts: { value: Sort; label: string }[] = [
  { value: "relevance", label: "Relevant" },
  { value: "engagement", label: "Relevant + engagement" },
  { value: "likes", label: "Most liked" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];

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

  const [view, setView] = useState<ViewMode>(ViewMode.Search),
    [modal, setModal] = useState<ModalKind | null>(null);

  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [accountInput, setAccountInput] = useState(""),
    [since, setSince] = useState("");

  const [page, setPage] = useState<{
    title: string;
    text: string;
    url: string;
    collectedAt: number;
  } | null>(null);

  const [contextPages, setContextPages] = useState<
    { title: string; text: string; url: string; collectedAt: number }[] | null
  >(null);

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
      setView(ViewMode.Search);
      setProposal(null);
    }
  }

  const dashboard = route.dashboard;
  const accountResults = useQuery(api.search.accounts);
  const accounts = accountResults ?? [];
  // `configured.indexing` decays with real time (worker liveness), not only
  // when the underlying row changes — convex/integrations.ts requires `now`
  // for exactly the reason convex/summary.ts's queries do (a query re-runs
  // on a document write, never merely because time passed). Refresh it on
  // the shared dashboard clock rather than once at mount.
  const now = useDashboardNow();
  const configured = useQuery(api.integrations.configured, { now });
  const libraryLoading = accountResults === undefined || configured === undefined;
  // The caller's own identity (convex/auth.ts `me`) — never a client-supplied
  // id. `verifiedEmail` narrows straight to the one address `email.send` will
  // ever accept (it requires an exact, case-insensitive match against the
  // signed-in identity's own verified email — convex/email.ts `send`), so
  // there is nothing to type or get wrong at send time.
  const me = useQuery(api.auth.me);
  const verifiedEmail = me?.emailVerified ? (me.email ?? null) : null;
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

  const jobs = useQuery(api.jobs.list, isAuthenticated ? {} : "skip") ?? [];
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
        telemetry.markSession(request.attemptId, id, connectionSnapshot);
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
    if (node === null || searchRequest === null) return;

    if (kickedAttempt.current === searchRequest.attemptId) return;

    if (runSearch(searchRequest)) kickedAttempt.current = searchRequest.attemptId;
  }

  // Commit-phase telemetry: Profiler onRender (no useEffect) records render cost,
  // and the results ref below records first/terminal commits when Convex data lands.
  const onResultsRender: ResultsProfiler = (_id, _phase, actualDuration, baseDuration) => {
    const attempt = searchRequest?.attemptId;

    if (attempt !== undefined) telemetry.recordProfiler(attempt, actualDuration, baseDuration);
  };

  function resultsCommitRef(node: HTMLElement | null) {
    const req = searchRequest;

    if (!node || !req || !result || result._id !== sessionId) return;

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
    await start({ kind: "bulk", input: accountInput, since: since || undefined });
    setAccountInput("");
  };

  const runLoadLive = async () => {
    await ensureSession();
    await start({ kind: "live", input: raw.replace(/(^|\s)@([\w]+)/g, "$1from:$2") });
    setModal(ModalKind.Imports);
  };

  const runRead = async (url: string) => {
    await ensureSession();
    setPage(await readLink({ url }));
  };

  const proposeSearch = async () => {
    await ensureSession();
    setProposal(await interpret({ raw: draft }));
  };

  const runWebContext = async () => {
    await ensureSession();
    setContextPages(await webContext({ query: raw }));
  };

  const runThread = async (url: string) => {
    await ensureSession();
    await start({ kind: "post", input: url });
    setModal(ModalKind.Imports);
  };

  const runLoadMore = async () => {
    const next = result?.nextCursor;

    if (!next) return;

    const id = await startSearch({
      raw,
      sort,
      cursor: next,
      includeStats: result.includeStats === true,
    });

    setSessionId(id);
    window.scrollTo({ top: 0 });
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
    void task(submitImport(), "Indexing started. Raw captures are handed to your data service.");
  };

  const loadLive = () => void task(runLoadLive(), "Looking for more posts on X.");

  const read = (url: string) => {
    setReading(true);
    task(runRead(url), undefined, () => setReading(false));
  };

  const deferredRaw = useDeferredValue(raw);
  const visible = view === ViewMode.Bookmarks ? bookmarks : (result?.rows ?? []);
  const home = !deferredRaw && view === ViewMode.Search;

  const openDashboard = () => {
    if (!OPERATOR_BUILD) return;
    setModal(null);
    pushLocation({ dashboard: true });
  };

  const search = (query: string, nextSort: Sort = sort) => {
    const trimmed = query.trim();
    const attemptId = allocateAttempt();

    const request: SearchRequest = {
      raw: trimmed,
      sort: nextSort,
      includeStats: statsForNerds,
      attemptId,
      trigger: SearchTrigger.Submit,
    };

    setRaw(trimmed);
    setDraft(trimmed);
    setSort(nextSort);
    setSessionId(null);
    setSearchRequest(request);
    setView(ViewMode.Search);
    setProposal(null);
    pushLocation({ raw: trimmed, sort: nextSort, includeStats: statsForNerds });
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

    setSessionId(null);
    setSearchRequest(request);
    startSearchTransition(() => {
      if (runSearch(request)) kickedAttempt.current = request.attemptId;
    });
  };

  if (OPERATOR_BUILD && dashboard && Dashboard)
    return (
      <Suspense fallback={null}>
        <span ref={authProbe} hidden />
        <Dashboard
          ensureSession={ensureSession}
          close={() => {
            replaceLocation({ dashboard: false });
          }}
        />
      </Suspense>
    );

  return (
    <div className={`app ${home ? "is-home" : "has-results"}`}>
      <span ref={authProbe} hidden />
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
            onClick={() =>
              setView(view === ViewMode.Bookmarks ? ViewMode.Search : ViewMode.Bookmarks)
            }
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
            ? "Reconnecting to your search library…"
            : "Connecting to your search library…"}
        </p>
      )}
      <main ref={kickPendingRef}>
        <section className="search-stage" aria-label="Search X posts">
          {home && (
            <>
              <div className="orbit" role="group" aria-label="Imported accounts">
                {accounts.slice(0, 32).map((a, i, all) => {
                  const angle = (i / all.length) * Math.PI * 2 - Math.PI / 2;

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
                      <Avatar name={a.handle} url={a.avatar} />
                    </button>
                  );
                })}
              </div>
              <div className="hero-title">
                <p>Your people. Their words.</p>
                <h1>Search X posts.</h1>
              </div>
            </>
          )}
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              search(draft);
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
                onChange={(e) =>
                  search(
                    draft,
                    // SAFETY: every <option> below comes from `sorts`, whose
                    // `value`s are typed `Sort`, so the <select>'s string
                    // value is always one of them.
                    e.target.value as Sort,
                  )
                }
              >
                {sorts.map((s) => (
                  <option value={s.value} key={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button type="submit" className="primary">
                Search
              </button>
            </div>
            <div className="search-help">
              <span>
                Search everything, select a creator, or start with <b>@</b> to filter by account.
              </span>
              <label className="stats-toggle">
                <input
                  type="checkbox"
                  checked={statsForNerds}
                  onChange={(event) => setStatsForNerds(event.target.checked)}
                />
                Stats for nerds
              </label>
              {configured?.openai && (
                <button
                  type="button"
                  className="text-button ai"
                  disabled={busy || !draft.trim()}
                  title="Suggest a clearer search"
                  onClick={() => void task(proposeSearch())}
                >
                  <Sparkles size={13} />
                  Help me search
                </button>
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
          {home && (
            <div className="library-status" aria-live="polite">
              {libraryLoading ? (
                <>
                  <span className="status-dot loading" />
                  Loading your search library…
                </>
              ) : accounts.length ? (
                <>
                  <span className="status-dot" />
                  Select an imported account to search its posts
                </>
              ) : (
                <>
                  <span className="status-dot muted" />
                  Connect your sources to start searching.
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setModal(ModalKind.Imports)}
                  >
                    Import an account <Plus size={13} />
                  </button>
                </>
              )}
            </div>
          )}
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
                onThread={(post) => void task(runThread(post.url))}
                frontendStats={deferredFrontendStats}
                searchPending={isSearchPending}
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
            Collect an account’s public history through x.md. Raw captures go to your data service
            for normalization and storage; this app tracks the handoff.
          </p>
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
            <button className="primary" type="submit" disabled={busy || !configured?.indexing}>
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
            {jobs.map((job) => (
              <div className="job" key={job._id}>
                <div>
                  <strong>{job.kind === "bulk" ? `@${job.input}` : job.input}</strong>
                  <span className={`job-status ${job.status}`}>{jobLabel(job)}</span>
                </div>
                <p>{jobSummary(job)}</p>
                {job.error && <p className="config-warning">{job.error}</p>}
                {jobWarnings(job).map((w) => (
                  <p className="muted-copy" key={w}>
                    {w}
                  </p>
                ))}
                {/* An import runs to the end of what the provider has on its
                    own (convex/jobs.ts `finish` continues and retries by
                    itself), so the only thing left for a person is to resume
                    a run that gave up for good. That resumes THIS job where
                    it stopped — never a new job from its cursor. */}
                {(job.status === "failed" || job.status === "partial") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void task(
                        (async () => {
                          await ensureSession();
                          await retry({ jobId: job._id });
                        })(),
                      )
                    }
                  >
                    Retry import
                  </button>
                )}
              </div>
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
              <div className="page-text" key={p.url}>
                <strong>{p.title}</strong>
                <p>{p.text}</p>
              </div>
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
