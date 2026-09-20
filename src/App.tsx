import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
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
  Check,
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
import Dashboard from "./Dashboard";
import { ResultsSection, Avatar } from "./ResultsSection";
import { AccountBadge } from "./auth/AccountBadge";
import { EmailSignIn } from "./auth/EmailSignIn";
import { handoffReady, indexingUnavailableMessage } from "./integrationStatus";
import { describeError } from "./errors";
import { jobLabel, jobSummary, jobWarnings } from "./jobText";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ResultPost } from "../convex/lib/results";
import { parseQuery, type Sort } from "../convex/lib/search";

const sorts: { value: Sort; label: string }[] = [
  { value: "relevance", label: "Relevant" },
  { value: "engagement", label: "Relevant + engagement" },
  { value: "likes", label: "Most liked" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];
const fromLocation = () => {
  const params = new URLSearchParams(location.search);
  return {
    raw: params.get("q") ?? "",
    sort: (sorts.find((s) => s.value === params.get("sort"))?.value ?? "relevance") as Sort,
    includeStats: params.get("stats") === "1",
  };
};
export type Connection = {
  name: string;
  ready: boolean | undefined;
  purpose: string;
  env?: string;
  note?: string;
  /**
   * What `ready` actually proves. Almost every row reports whether an
   * environment variable is set, which is a configuration fact and must not
   * be worded as connectivity. A row is only "live" when its readiness comes
   * from a real signal, such as the download worker's heartbeat.
   */
  proves?: "configured" | "live";
};
/**
 * The "stores imported posts" row in the Connections panel means two
 * different things depending on `convex/integrations.ts`'s `configured`
 * query: in receiver mode it's a config question (set the env vars), in
 * outbound mode it's a liveness question about the download worker (which
 * reads RAW_CAPTURE_URL/TOKEN on its own machine — setting them here does
 * nothing). Keep the vocabulary consistent with
 * `integrationStatus.ts`'s `indexingUnavailableMessage`.
 */
export function receiverConnection(
  collectorMode: "outbound" | "receiver" | undefined,
  ready: boolean | undefined,
): Connection {
  if (collectorMode === "outbound")
    return {
      name: "Download worker",
      ready,
      purpose: "Stores imported posts",
      note: "Connects to this deployment on its own and reconnects automatically — there's nothing to set here.",
      proves: "live",
    };
  return {
    name: "Raw capture receiver",
    ready,
    env: "RAW_CAPTURE_URL, RAW_CAPTURE_TOKEN",
    purpose: "Stores imported posts",
  };
}
const safeHostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "Linked page";
  }
};
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
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
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
  const initial = fromLocation();
  const [draft, setDraft] = useState(initial.raw),
    [raw, setRaw] = useState(initial.raw),
    [sort, setSort] = useState<Sort>(initial.sort),
    [statsForNerds, setStatsForNerds] = useState(initial.includeStats),
    [searchRequest, setSearchRequest] = useState<{
      raw: string;
      sort: Sort;
      includeStats: boolean;
    } | null>(() =>
      initial.raw.trim()
        ? { raw: initial.raw, sort: initial.sort, includeStats: initial.includeStats }
        : null,
    );
  const [sessionId, setSessionId] = useState<Id<"sessions"> | null>(null);
  const [view, setView] = useState<"search" | "bookmarks">("search"),
    [modal, setModal] = useState<"imports" | "saved" | "email" | "setup" | null>(null);
  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [accountInput, setAccountInput] = useState(""),
    [since, setSince] = useState("");
  const [dashboard, setDashboard] = useState(() =>
    new URLSearchParams(location.search).has("dashboard"),
  );
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
  const { isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();
  const connection = useConvexConnectionState();
  const session = useRef<Promise<unknown> | null>(null);
  const authReady = useRef(isAuthenticated);
  const authWaiters = useRef<(() => void)[]>([]);
  useEffect(() => {
    authReady.current = isAuthenticated;
    if (isAuthenticated) {
      for (const resolve of authWaiters.current.splice(0)) resolve();
    }
  }, [isAuthenticated]);
  const ensureSession = useCallback(async () => {
    if (authReady.current) return;
    const pending = (async () => {
      await signIn("anonymous");
      // signIn stores tokens before the Convex websocket confirms authentication.
      if (!authReady.current)
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            authWaiters.current = authWaiters.current.filter((fn) => fn !== done);
            reject(new Error("Session connection timed out. Try again."));
          }, 20_000);
          authWaiters.current.push(done);
        });
    })();
    pending.finally(() => {
      session.current = null;
    });
    session.current = pending;
    await pending;
  }, [signIn]);
  const accountResults = useQuery(api.search.accounts);
  const accounts = accountResults ?? [];
  const configured = useQuery(api.integrations.configured);
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
    queryError = (e as Error).message;
  }
  const snapshot = useQuery(
    api.search.results,
    sessionId && isAuthenticated ? { sessionId } : "skip",
  );
  const result = snapshot?.raw === raw && snapshot.sort === sort ? snapshot : undefined;
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
    modal === "email" && sessionId && isAuthenticated ? { sessionId } : "skip",
  );
  const startSearch = useMutation(api.search.start);
  const start = useMutation(api.jobs.start),
    bookmark = useMutation(api.search.bookmark),
    save = useMutation(api.search.save),
    removeSaved = useMutation(api.search.removeSaved),
    send = useMutation(api.email.send);
  const webContext = useAction(api.integrations.webContext);
  const readLink = useAction(api.integrations.readLink),
    interpret = useAction(api.integrations.interpret);

  // NB: `task` is deliberately a plain async function, not a useCallback: it
  // only ever runs in event handlers, so the stable closure it needs is the
  // one formed per render, and memoizing it would add a dependency without
  // changing any behavior.
  const task = async (fn: () => Promise<unknown>, success?: string) => {
    setNotice("");
    setBusy(true);
    try {
      await fn();
      if (success) setNotice(success);
    } catch (e) {
      setNotice(describeError(e));
    } finally {
      setBusy(false);
    }
  };
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
    setModal("imports");
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
    setModal("imports");
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
    void task(submitImport, "Indexing started. Raw captures are handed to your data service.");
  };
  const loadLive = () =>
    void task(runLoadLive, "Looking for more posts on X.");
  const read = (url: string) => {
    setReading(true);
    void task(() => runRead(url)).finally(() => setReading(false));
  };
  // Worker liveness is judged against this clock, not inside the Convex
  // query — a query re-runs when a document changes, never because time
  // passed, so a server-decided boolean would stay true after the worker
  // went quiet. Ticking here lets the badge decay on its own.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const connections: Connection[] = [
    {
      name: "Search service",
      ready: configured?.search,
      env: "SEARCH_API_URL, SEARCH_SERVICE_TOKEN",
      purpose: "Finds posts in your library",
    },
    // Falls back to the public flag when the timestamp was not disclosed
    // (signed out), so a visitor sees exactly what they saw before worker
    // timing was ever returned, rather than a permanent "Checking…".
    receiverConnection(
      configured?.collectorMode,
      handoffReady(configured?.handoffState, now) ?? configured?.handoff,
    ),
    {
      name: "x.md",
      ready: configured?.xmd,
      env: "X_MD_API_KEY",
      purpose: "Account histories, live search, conversations",
    },
    {
      name: "Firecrawl",
      ready: configured?.firecrawl,
      env: "FIRECRAWL_API_KEY",
      purpose: "Reads pages linked in posts",
    },
    {
      name: "OpenAI",
      ready: configured?.openai,
      env: "OPENAI_API_KEY",
      purpose: "Turns a question into a clearer search",
    },
    {
      name: "AgentMail",
      ready: configured?.email,
      env: "AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID",
      purpose: "Emails search results",
    },
  ];
  const visible = view === "bookmarks" ? bookmarks : (result?.rows ?? []);
  const home = !raw && view === "search";
  const openDashboard = () => {
    setModal(null);
    setDashboard(true);
    const url = new URL(location.href);
    url.searchParams.set("dashboard", "1");
    history.replaceState(null, "", url);
  };
  const search = (query: string, nextSort: Sort = sort) => {
    setRaw(query.trim());
    setDraft(query.trim());
    setSort(nextSort);
    setSessionId(null);
    setSearchRequest({ raw: query.trim(), sort: nextSort, includeStats: statsForNerds });
    setView("search");
    setProposal(null);
    const url = new URL(location.href);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    url.searchParams.set("sort", nextSort);
    if (statsForNerds) url.searchParams.set("stats", "1");
    else url.searchParams.delete("stats");
    history.pushState(null, "", url);
  };
  useEffect(() => {
    const pop = () => {
      const state = fromLocation();
      setRaw(state.raw);
      setDraft(state.raw);
      setSort(state.sort);
      setStatsForNerds(state.includeStats);
      setSessionId(null);
      setSearchRequest(
        state.raw.trim()
          ? { raw: state.raw, sort: state.sort, includeStats: state.includeStats }
          : null,
      );
      setView("search");
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (!searchRequest || queryError || !configured?.search) return;
    let active = true;
    // Every setState here runs after an await, never synchronously in the effect body.
    void (async () => {
      await ensureSession();
      if (!active) return;
      const { raw: query, sort: requestedSort, includeStats } = searchRequest;
      setBusy(true);
      setNotice("");
      try {
        const id = await startSearch({ raw: query, sort: requestedSort, includeStats });
        if (active) setSessionId(id);
      } catch (e) {
        if (active) setNotice(describeError(e));
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [searchRequest, configured?.search, queryError, ensureSession, startSearch]);

  if (dashboard)
    return (
      <Dashboard
        ensureSession={ensureSession}
        close={() => {
          setDashboard(false);
          const url = new URL(location.href);
          url.searchParams.delete("dashboard");
          history.replaceState(null, "", url);
        }}
      />
    );
  return (
    <div className={`app ${home ? "is-home" : "has-results"}`}>
      <header className="topbar">
        <button type="button" className="wordmark" onClick={() => search("")} aria-label="Xearch home">
          xearch<span className="wordmark-dot">.</span>
        </button>
        <nav aria-label="Main navigation">
          <button type="button" aria-label="Import dashboard" onClick={openDashboard}>
            <LayoutDashboard size={15} />
            <span>Dashboard</span>
          </button>
          <button
            type="button"
            aria-label="Saved searches"
            onClick={() => {
              setModal("saved");
            }}
          >
            <Clock3 size={15} />
            <span>Saved searches</span>
          </button>
          <button
            type="button"
            aria-label="Bookmarks"
            aria-pressed={view === "bookmarks"}
            onClick={() => setView(view === "bookmarks" ? "search" : "bookmarks")}
          >
            <Bookmark size={15} />
            <span>Bookmarks</span>
            {bookmarks.length > 0 && <small>{bookmarks.length}</small>}
          </button>
          <button
            type="button"
            aria-label="Import account"
            className="import-nav"
            onClick={() => setModal("imports")}
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
      <main>
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
                onChange={(e) => search(draft, e.target.value as Sort)}
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
                  onClick={() =>
                    void task(proposeSearch)
                  }
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
                    onClick={() => setModal("imports")}
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
            <button type="button" className="icon" aria-label="Dismiss message" onClick={() => setNotice("")}>
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
            onSave={() => void task(runSave, "Search saved.")}
            onLiveSearch={loadLive}
            onOpenModal={(which) => setModal(which)}
            onRetry={() => setSearchRequest({ raw, sort, includeStats: statsForNerds })}
            onWebContext={runWebContext}
            onLoadMore={runLoadMore}
            onRead={read}
            onBookmark={(post) =>
              void task(() => runBookmark(post))
            }
            onThread={(post) =>
              void task(() => runThread(post.url))
            }
          />
        )}
      </main>
      <footer className="site-footer">
        <span>Find the words. Keep the context.</span>
        <div>
          <a href="https://mdfromx.com" target="_blank" rel="noreferrer">
            Powered by x.md <ArrowUpRight size={12} />
          </a>
          <button type="button" onClick={() => setModal("setup")}>
            <SlidersHorizontal size={13} />
            Connections
          </button>
        </div>
      </footer>
      {modal === "imports" && (
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
              <p className="config-warning">{indexingUnavailableMessage(configured)}</p>
            )}
            <button type="button" className="text-button" onClick={openDashboard}>
              More options in the dashboard <ArrowUpRight size={13} />
            </button>
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
                {job.status !== "running" &&
                  job.status !== "queued" &&
                  (job.status === "failed" ||
                    job.status === "partial" ||
                    job.nextUntil ||
                    job.nextCursor) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void task(async () => {
                          await ensureSession();
                          await start({
                            kind: job.kind,
                            input: job.input,
                            since: job.since,
                            previous: job._id,
                          });
                        })
                      }
                    >
                      {job.nextUntil
                        ? "Import older posts"
                        : job.nextCursor
                          ? "Get next page"
                          : "Retry import"}
                    </button>
                  )}
              </div>
            ))}
          </div>
        </Modal>
      )}
      {modal === "saved" && (
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
                onClick={() => void task(() => runRemoveSaved(item._id))}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </Modal>
      )}
      {modal === "email" && (
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
                  void task(async () => {
                    await ensureSession();
                    await send({ sessionId: sessionId!, recipient: verifiedEmail });
                  }, "Email queued. Delivery status appears below.");
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
      {modal === "setup" && (
        <Modal notice={notice} title="Connections" close={() => setModal(null)}>
          <p className="muted-copy">
            Search is live once your data service returns results. The remaining connections are
            optional improvements.
          </p>
          {connections.map((c) => (
            <div className="connection-row" key={c.name}>
              <div>
                <strong>{c.name}</strong>
                <p>{c.purpose}</p>
                <small>
                  {configured === undefined ? (
                    "Checking…"
                  ) : (
                    <>
                      {c.ready ? <Check size={12} /> : <span className="status-dot" />}{" "}
                      {c.ready
                        ? c.proves === "live"
                          ? "Connected"
                          : "Configured"
                        : c.proves === "live"
                          ? "Not connected"
                          : "Not configured"}
                      {c.env ? ` · ${c.env}` : ""}
                    </>
                  )}
                </small>
                {c.note && <small>{c.note}</small>}
              </div>
            </div>
          ))}
          {configured?.collectorMode === "outbound" && <AccountBadge />}
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