import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  useAction,
  useConvexAuth,
  useMutation,
  useQuery,
  useConvexConnectionState,
} from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  ArrowUpRight,
  Bookmark,
  Check,
  Clock3,
  Download,
  ExternalLink,
  Heart,
  Link2,
  LayoutDashboard,
  Mail,
  MessageCircle,
  Plus,
  Repeat2,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import Dashboard from "./Dashboard";
import { EmailSignIn } from "./auth/EmailSignIn";
import { AccountBadge } from "./auth/AccountBadge";
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
const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const postDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const compact = (n: number) => compactNumber.format(n);
const formatDuration = (microseconds: number) => `${(microseconds / 1000).toFixed(2)} ms`;
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
function Avatar({ name, url }: { name: string; url?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <span className="avatar">
      {url && url !== failedUrl ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        name.slice(0, 2).toUpperCase()
      )}
    </span>
  );
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
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
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
function Highlight({ text, query }: { text: string; query: string }) {
  const words = query
    .split(/\s+/)
    .filter((w) => w.length > 2 && !w.startsWith("@"))
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.join("|")})`, "gi");
  const parts: { key: string; text: string; mark: boolean }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor)
      parts.push({ key: `text-${cursor}`, text: text.slice(cursor, start), mark: false });
    parts.push({ key: `mark-${start}`, text: match[0], mark: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length)
    parts.push({ key: `text-${cursor}`, text: text.slice(cursor), mark: false });
  return (
    <>
      {parts.map((part) =>
        part.mark ? (
          <mark key={part.key}>{part.text}</mark>
        ) : (
          <span key={part.key}>{part.text}</span>
        ),
      )}
    </>
  );
}
function PostCard({
  post,
  query,
  bookmarked,
  onBookmark,
  onThread,
  onRead,
  onAuthor,
}: {
  post: ResultPost;
  query: string;
  bookmarked: boolean;
  onBookmark: () => void;
  onThread: () => void;
  onRead: (url: string) => void;
  onAuthor: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const createdAt = post.createdAt === undefined ? null : new Date(post.createdAt);
  const hasValidDate = createdAt !== null && !Number.isNaN(createdAt.getTime());
  return (
    <article className="post">
      <header>
        <button className="author" onClick={onAuthor}>
          <Avatar name={post.author} url={post.avatar} />
          <span>
            <strong>{post.displayName ?? post.author}</strong>
            <small>@{post.author}</small>
          </span>
        </button>
        <div className="post-meta">
          {hasValidDate ? (
            <time dateTime={createdAt.toISOString()}>{postDate.format(createdAt)}</time>
          ) : null}
          <button
            className={`icon ${bookmarked ? "accent" : ""}`}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark post"}
            onClick={onBookmark}
          >
            <Bookmark size={17} fill={bookmarked ? "currentColor" : "none"} />
          </button>
        </div>
      </header>
      <p className="post-text">
        <Highlight
          text={!expanded && post.text.length > 700 ? `${post.text.slice(0, 700)}…` : post.text}
          query={query}
        />
      </p>
      {post.text.length > 700 && (
        <button className="text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Read full post"}
        </button>
      )}
      {post.links.length > 0 && (
        <div className="links">
          {post.links.slice(0, 3).map((url) => (
            <button key={url} onClick={() => onRead(url)} title={url}>
              <Link2 size={14} />
              <span>{safeHostname(url)}</span>
              <ArrowUpRight size={13} />
            </button>
          ))}
        </div>
      )}
      <footer>
        <div className="metrics">
          {post.likes !== undefined && (
            <span title="Likes at collection time">
              <Heart size={14} />
              {compact(post.likes)}
            </span>
          )}
          {post.reposts !== undefined && (
            <span title="Reposts at collection time">
              <Repeat2 size={14} />
              {compact(post.reposts)}
            </span>
          )}
          {post.replies !== undefined && (
            <span title="Replies at collection time">
              <MessageCircle size={14} />
              {compact(post.replies)}
            </span>
          )}
        </div>
        <div className="post-actions">
          <button onClick={onThread}>Conversation</button>
          <a href={post.url} target="_blank" rel="noreferrer">
            Open on X <ArrowUpRight size={14} />
          </a>
        </div>
      </footer>
    </article>
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
    session.current ??= (async () => {
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
    })().finally(() => {
      session.current = null;
    });
    await session.current;
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
    const { raw: query, sort: requestedSort, includeStats } = searchRequest;
    let active = true;
    // Every setState here runs after an await, never synchronously in the effect body.
    void (async () => {
      await ensureSession();
      if (!active) return;
      setBusy(true);
      setNotice("");
      try {
        const id = await startSearch({
          raw: query,
          sort: requestedSort,
          includeStats,
        });
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
  const importAccount = (e: FormEvent) => {
    e.preventDefault();
    void task(async () => {
      await ensureSession();
      await start({
        kind: "bulk",
        input: accountInput,
        since: since || undefined,
      });
      setAccountInput("");
    }, "Indexing started. Raw captures are handed to your data service.");
  };
  const loadLive = () =>
    task(async () => {
      await ensureSession();
      await start({
        kind: "live",
        input: raw.replace(/(^|\s)@([\w]+)/g, "$1from:$2"),
      });
      setModal("imports");
    }, "Looking for more posts on X.");
  const read = (url: string) => {
    setReading(true);
    void task(async () => {
      await ensureSession();
      setPage(await readLink({ url }));
    }).finally(() => setReading(false));
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
    receiverConnection(configured?.collectorMode, handoffReady(configured?.handoffState, now)),
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
  const resultsTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (view !== "bookmarks") return;
    resultsTitle.current?.scrollIntoView({ block: "start" });
    resultsTitle.current?.focus({ preventScroll: true });
  }, [view]);
  const openDashboard = () => {
    setModal(null);
    setDashboard(true);
    const url = new URL(location.href);
    url.searchParams.set("dashboard", "1");
    history.replaceState(null, "", url);
  };

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
        <button className="wordmark" onClick={() => search("")} aria-label="Xearch home">
          xearch<span className="wordmark-dot">.</span>
        </button>
        <nav aria-label="Main navigation">
          <button aria-label="Import dashboard" onClick={openDashboard}>
            <LayoutDashboard size={15} />
            <span>Dashboard</span>
          </button>
          <button
            aria-label="Saved searches"
            onClick={() => {
              setModal("saved");
            }}
          >
            <Clock3 size={15} />
            <span>Saved searches</span>
          </button>
          <button
            aria-label="Bookmarks"
            aria-pressed={view === "bookmarks"}
            onClick={() => setView(view === "bookmarks" ? "search" : "bookmarks")}
          >
            <Bookmark size={15} />
            <span>Bookmarks</span>
            {bookmarks.length > 0 && <small>{bookmarks.length}</small>}
          </button>
          <button
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
                    void task(async () => {
                      await ensureSession();
                      setProposal(await interpret({ raw: draft }));
                    })
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
                  <button className="text-button" onClick={() => setModal("imports")}>
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
            <button className="icon" aria-label="Dismiss message" onClick={() => setNotice("")}>
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
          <section className="results">
            <header className="results-header">
              <div>
                <h1 ref={resultsTitle} tabIndex={-1}>
                  {view === "bookmarks" ? "Bookmarks" : raw}
                </h1>
                <p>
                  {view === "bookmarks"
                    ? `${bookmarks.length} saved posts in this browser's session`
                    : configured === undefined
                      ? "Checking your search service connection"
                      : !configured.search
                        ? "Waiting for the search service connection"
                        : result?.status === "complete"
                          ? `${result.rows.length} posts on this page`
                          : result?.status === "failed"
                            ? "Search could not complete"
                            : "Finding matching posts…"}
                </p>
              </div>
              {view === "search" && (
                <div className="result-tools">
                  <button
                    title="Save search"
                    disabled={busy || !!queryError}
                    onClick={() =>
                      void task(async () => {
                        await ensureSession();
                        await save({ raw, sort });
                      }, "Search saved.")
                    }
                  >
                    <Bookmark size={15} />
                    Save search
                  </button>
                  <button
                    disabled={busy || !configured?.firecrawl}
                    onClick={() =>
                      void task(async () => {
                        await ensureSession();
                        setContextPages(await webContext({ query: raw }));
                      })
                    }
                  >
                    <Link2 size={15} />
                    Web context
                  </button>
                  <button
                    title="Email top results"
                    disabled={!visible.length || !configured?.email}
                    onClick={() => setModal("email")}
                  >
                    <Mail size={15} />
                    Email
                  </button>
                  <button disabled={busy || !configured?.indexing} onClick={() => void loadLive()}>
                    <Search size={15} />
                    Find on X
                  </button>
                </div>
              )}
            </header>
            {queryError ? (
              <div className="empty">
                <h2>Adjust your search</h2>
                <p>{queryError}</p>
              </div>
            ) : view === "search" && configured === undefined ? (
              <div className="empty" role="status">
                Checking your connections…
              </div>
            ) : view === "search" && configured?.search === false ? (
              <div className="empty">
                <Search size={30} />
                <h2>Connect the search service.</h2>
                <p>
                  The interface is ready. Your data service supplies the corpus and search results.
                </p>
                <button onClick={() => setModal("setup")}>View connections</button>
              </div>
            ) : result?.status === "failed" ? (
              <div className="empty">
                <h2>Search could not complete</h2>
                <p>{result.error}</p>
                <button
                  onClick={() => setSearchRequest({ raw, sort, includeStats: statsForNerds })}
                >
                  Retry search
                </button>
              </div>
            ) : view === "search" && (!result || result.status !== "complete") ? (
              <div className="empty" role="status">
                Finding matching posts…
              </div>
            ) : !visible.length ? (
              <div className="empty">
                <Search size={30} />
                <h2>
                  {view === "bookmarks"
                    ? "Keep the posts worth finding again."
                    : "No matches in your library yet."}
                </h2>
                <p>
                  {view === "bookmarks"
                    ? "Use the bookmark button on any result."
                    : "Import an account's history, try fewer keywords, or find more posts on X."}
                </p>
                {view === "search" && (
                  <button onClick={() => setModal("imports")}>
                    <Plus size={15} />
                    Import an account
                  </button>
                )}
              </div>
            ) : (
              <>
                <p className="scope-note">
                  Results and ordering come from your search service. Engagement reflects the source
                  snapshot.
                </p>
                {result?.stats && (
                  <details className="stats-panel">
                    <summary>
                      Stats for nerds —{" "}
                      {formatDuration(result.stats.api?.totalUs ?? result.stats.backend.totalUs)}
                    </summary>
                    <div className="stats-grid">
                      <strong>Backend</strong>
                      <span>Total</span>
                      <span>{formatDuration(result.stats.backend.totalUs)}</span>
                      <span>Reload index</span>
                      <span>{formatDuration(result.stats.backend.reloadUs)}</span>
                      <span>Fingerprint</span>
                      <span>{formatDuration(result.stats.backend.fingerprintUs)}</span>
                      <span>Compile query</span>
                      <span>{formatDuration(result.stats.backend.compileUs)}</span>
                      <span>Retrieve</span>
                      <span>{formatDuration(result.stats.backend.retrieveUs)}</span>
                      <span>Retrieve + rank candidates</span>
                      <span>{result.stats.backend.rankingCalls} calls</span>
                      <span>Materialize rows</span>
                      <span>{formatDuration(result.stats.backend.materializeUs)}</span>
                      <span>Hits / returned</span>
                      <span>
                        {result.stats.backend.candidateHits} / {result.stats.backend.returnedRows}
                      </span>
                      <span>Index</span>
                      <span>
                        {result.stats.backend.indexDocs} docs / {result.stats.backend.segments}{" "}
                        segments
                      </span>
                      {result.stats.api && (
                        <>
                          <strong>API</strong>
                          <span>Auth</span>
                          <span>{formatDuration(result.stats.api.authUs)}</span>
                          <span>Parse</span>
                          <span>{formatDuration(result.stats.api.parseUs)}</span>
                          <span>Queue</span>
                          <span>{formatDuration(result.stats.api.queueUs)}</span>
                          <span>Engine wall</span>
                          <span>{formatDuration(result.stats.api.engineUs)}</span>
                          <span>Post-process</span>
                          <span>{formatDuration(result.stats.api.postprocessUs)}</span>
                          <span>API total</span>
                          <span>{formatDuration(result.stats.api.totalUs)}</span>
                        </>
                      )}
                    </div>
                  </details>
                )}
                {result?.warnings.map((warning) => (
                  <p className="scope-note" key={warning}>
                    {warning}
                  </p>
                ))}
                <div className="post-list">
                  {visible.map((post) => (
                    <PostCard
                      key={post.tweetId}
                      post={post}
                      query={raw}
                      bookmarked={bookmarks.some((b) => b.tweetId === post.tweetId)}
                      onAuthor={() => search(`@${post.author}`)}
                      onBookmark={() =>
                        void task(async () => {
                          await ensureSession();
                          await bookmark({
                            tweetId: post.tweetId,
                            sessionId: sessionId ?? undefined,
                          });
                        })
                      }
                      onThread={() =>
                        void task(async () => {
                          await ensureSession();
                          await start({ kind: "post", input: post.url });
                          setModal("imports");
                        }, "Fetching available conversation posts.")
                      }
                      onRead={read}
                    />
                  ))}
                </div>
                {view === "search" && result?.nextCursor && (
                  <button
                    className="load-more"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        const id = await startSearch({
                          raw,
                          sort,
                          cursor: result.nextCursor,
                          includeStats: result.includeStats === true,
                        });
                        setSessionId(id);
                        window.scrollTo({ top: 0 });
                      })
                    }
                  >
                    Next page
                  </button>
                )}
              </>
            )}
          </section>
        )}
      </main>
      <footer className="site-footer">
        <span>Find the words. Keep the context.</span>
        <div>
          <a href="https://mdfromx.com" target="_blank" rel="noreferrer">
            Powered by x.md <ArrowUpRight size={12} />
          </a>
          <button onClick={() => setModal("setup")}>
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
            <button className="primary" disabled={busy || !configured?.indexing}>
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
                onClick={() => {
                  search(item.query, item.sort);
                  setModal(null);
                }}
              >
                <Search size={16} />
                {item.query}
              </button>
              <button
                className="icon"
                aria-label={`Remove ${item.query}`}
                onClick={() => void task(() => removeSaved({ id: item._id }))}
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
                <button className="primary" disabled={busy || !sessionId}>
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
            Configured on the backend by the operator. Nothing here is stored in your browser.
          </p>
          <div className="connection-row">
            <div>
              <strong>Account</strong>
              <AccountBadge />
            </div>
            {!verifiedEmail && (
              <>
                <p>
                  Sign in with a verified email to send digest emails to yourself. Search and every
                  other feature stay available as a guest.
                </p>
                <EmailSignIn
                  className="stack-form"
                  onSignedIn={() => setNotice("Signed in with a verified email address.")}
                />
              </>
            )}
          </div>
          {connections.map((c) => (
            <div className="connection-row" key={c.name}>
              <div>
                <strong>{c.name}</strong>
                <span className={c.ready ? "is-ready" : ""}>
                  {configured === undefined ? (
                    "Checking…"
                  ) : c.ready ? (
                    <>
                      <Check size={13} />
                      {c.proves === "live" ? "Connected" : "Configured"}
                    </>
                  ) : c.proves === "live" ? (
                    "Not connected"
                  ) : (
                    "Not configured"
                  )}
                </span>
              </div>
              <p>{c.purpose}</p>
              {c.note && <p>{c.note}</p>}
            </div>
          ))}
          <details className="local-setup">
            <summary>Local setup</summary>
            <p className="muted-copy">
              <code>bunx convex env set NAME</code> prompts for each value. Webhook and production
              steps are in the README.
            </p>
            {/* Only rows that actually have variables to set belong here.
                A row with nothing to configure already explains itself on
                its own card above; repeating that sentence inside a section
                titled "Local setup" told people to set up something that
                needs no setting up. */}
            {connections
              .filter((c) => c.env)
              .map((c) => (
                <p key={c.name}>
                  {c.name}: <code>{c.env}</code>
                </p>
              ))}
          </details>
        </Modal>
      )}
      {contextPages && (
        <Modal title="Web context" close={() => setContextPages(null)}>
          <p className="muted-copy">
            Related pages found and read by Firecrawl. These are web results, separate from the X
            corpus.
          </p>
          {contextPages.length === 0 ? (
            <p>No related pages returned.</p>
          ) : (
            contextPages.map((p) => (
              <div className="job" key={p.url}>
                <strong>{p.title}</strong>
                <p>
                  {p.text.slice(0, 350)}
                  {p.text.length > 350 ? "…" : ""}
                </p>
                <button
                  onClick={() => {
                    setContextPages(null);
                    setPage(p);
                  }}
                >
                  Read page
                </button>
              </div>
            ))
          )}
        </Modal>
      )}
      {page && (
        <Modal title={page.title} close={() => setPage(null)}>
          <p className="muted-copy">
            Collected {new Date(page.collectedAt).toLocaleString()}. This is a current-source
            preview, not an archive of the page when the post was written.
          </p>
          <a className="source-link" href={page.url} target="_blank" rel="noreferrer">
            Open original <ExternalLink size={14} />
          </a>
          <p className="page-text">{page.text}</p>
        </Modal>
      )}
    </div>
  );
}
