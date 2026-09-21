import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { site } from "./styles/site.stylex";
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
import { ResultsSection, Avatar } from "./ResultsSection";
import { EmailSignIn } from "./auth/EmailSignIn";
import { IMPORTS_UNAVAILABLE } from "./integrationStatus";
import { ConnectionsPanel, Dashboard, OPERATOR_BUILD } from "./operatorSurface";
import { useTask } from "./errors";
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
      <div {...stylex.props(site.modalInner)}>
        <header {...stylex.props(site.modalHeader)}>
          <h2 id={titleId} {...stylex.props(site.modalTitle)}>
            {title}
          </h2>
          <button
            type="button"
            {...stylex.props(site.iconButton)}
            onClick={close}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </header>
        <div {...stylex.props(site.modalBody)}>
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
  // The busy flag and the one notice line live in src/errors.ts alongside
  // `describeError`: the place that decides what a person is told when
  // something throws also owns saying it. `task` is that module's runner,
  // reached through the hook so this component never holds the setters the
  // runner writes through.
  const { busy, message: notice, setMessage: setNotice, run: task } = useTask();
  const [accountInput, setAccountInput] = useState(""),
    [since, setSince] = useState("");
  const [dashboard, setDashboard] = useState(
    () => OPERATOR_BUILD && new URLSearchParams(location.search).has("dashboard"),
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
  const loadLive = () => void task(runLoadLive, "Looking for more posts on X.");
  const read = (url: string) => {
    setReading(true);
    void task(() => runRead(url)).finally(() => setReading(false));
  };
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
      await task(
        async () => {
          const id = await startSearch({ raw: query, sort: requestedSort, includeStats });
          if (active) setSessionId(id);
        },
        // A superseded search must not clear the newer one's spinner or
        // overwrite its notice, so this run goes quiet once cleanup has run.
        { alive: () => active },
      );
    })();
    return () => {
      active = false;
    };
  }, [searchRequest, configured?.search, queryError, ensureSession, startSearch, task]);

  if (dashboard && Dashboard)
    return (
      <Suspense fallback={null}>
        <Dashboard
          ensureSession={ensureSession}
          close={() => {
            setDashboard(false);
            const url = new URL(location.href);
            url.searchParams.delete("dashboard");
            history.replaceState(null, "", url);
          }}
        />
      </Suspense>
    );
  return (
    <div {...stylex.props(site.app)}>
      <header {...stylex.props(site.topbar)}>
        <button
          type="button"
          {...stylex.props(site.wordmark)}
          onClick={() => search("")}
          aria-label="Xearch home"
        >
          xearch<span {...stylex.props(site.wordmarkDot)}>.</span>
        </button>
        <nav aria-label="Main navigation" {...stylex.props(site.nav)}>
          {OPERATOR_BUILD && (
            <button
              type="button"
              aria-label="Import dashboard"
              onClick={openDashboard}
              {...stylex.props(site.navButton)}
            >
              <LayoutDashboard size={15} />
              <span {...stylex.props(site.navButtonLabel)}>Dashboard</span>
            </button>
          )}
          <button
            type="button"
            aria-label="Saved searches"
            {...stylex.props(site.navButton)}
            onClick={() => {
              setModal("saved");
            }}
          >
            <Clock3 size={15} />
            <span {...stylex.props(site.navButtonLabel)}>Saved searches</span>
          </button>
          <button
            type="button"
            aria-label="Bookmarks"
            aria-pressed={view === "bookmarks"}
            {...stylex.props(site.navButton, view === "bookmarks" && site.navButtonPressed)}
            onClick={() => setView(view === "bookmarks" ? "search" : "bookmarks")}
          >
            <Bookmark size={15} />
            <span {...stylex.props(site.navButtonLabel)}>Bookmarks</span>
            {bookmarks.length > 0 && (
              <small {...stylex.props(site.navCount)}>{bookmarks.length}</small>
            )}
          </button>
          <button
            type="button"
            aria-label="Import account"
            {...stylex.props(site.navButton, site.importNav)}
            onClick={() => setModal("imports")}
          >
            <Plus size={16} />
            <span {...stylex.props(site.navButtonLabel)}>Import account</span>
          </button>
        </nav>
      </header>
      {!connection.isWebSocketConnected && (
        <p {...stylex.props(site.connection)} role="status">
          <span {...stylex.props(site.connectionDot)} />
          {connection.hasEverConnected
            ? "Reconnecting to your search library…"
            : "Connecting to your search library…"}
        </p>
      )}
      <main>
        <section
          aria-label="Search X posts"
          {...stylex.props(site.searchStage, home ? site.searchStageHome : site.searchStageResults)}
        >
          {home && (
            <>
              <div role="group" aria-label="Imported accounts" {...stylex.props(site.orbit)}>
                {accounts.slice(0, 32).map((a, i, all) => {
                  const angle = (i / all.length) * Math.PI * 2 - Math.PI / 2;
                  const orbit = stylex.props(site.orbitButton);
                  return (
                    <button
                      type="button"
                      title={`Search @${a.handle}`}
                      aria-label={`Search @${a.handle}`}
                      key={a._id}
                      {...orbit}
                      style={
                        {
                          ...orbit.style,
                          "--left": `${50 + 44 * Math.cos(angle)}%`,
                          "--top": `${50 + 45 * Math.sin(angle)}%`,
                        } as CSSProperties
                      }
                      onClick={() => search(`@${a.handle}`)}
                    >
                      <Avatar name={a.handle} url={a.avatar} large />
                    </button>
                  );
                })}
              </div>
              <div {...stylex.props(site.heroTitle)}>
                <p {...stylex.props(site.heroKicker)}>Your people. Their words.</p>
                <h1 {...stylex.props(site.heroHeading)}>Search X posts.</h1>
              </div>
            </>
          )}
          <form
            {...stylex.props(site.searchForm, home ? site.searchFormHome : site.searchFormResults)}
            onSubmit={(e) => {
              e.preventDefault();
              search(draft);
            }}
          >
            <label htmlFor="query" {...stylex.props(site.searchLabel)}>
              Search posts
            </label>
            <div {...stylex.props(site.searchControls)}>
              <div {...stylex.props(site.queryWrap)}>
                <Search size={19} {...stylex.props(site.queryIcon)} />
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
                  {...stylex.props(site.queryInput)}
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
                {...stylex.props(site.searchSelect)}
              >
                {sorts.map((s) => (
                  <option value={s.value} key={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button type="submit" {...stylex.props(site.primary)}>
                Search
              </button>
            </div>
            <div {...stylex.props(site.searchHelp)}>
              <span>
                Search everything, select a creator, or start with{" "}
                <b {...stylex.props(site.searchHelpAt)}>@</b> to filter by account.
              </span>
              <label {...stylex.props(site.statsToggle)}>
                <input
                  type="checkbox"
                  checked={statsForNerds}
                  onChange={(event) => setStatsForNerds(event.target.checked)}
                  {...stylex.props(site.statsCheckbox)}
                />
                Stats for nerds
              </label>
              {configured?.openai && (
                <button
                  type="button"
                  disabled={busy || !draft.trim()}
                  title="Suggest a clearer search"
                  onClick={() => void task(proposeSearch)}
                  {...stylex.props(site.textButton, site.aiButton)}
                >
                  <Sparkles size={13} />
                  Help me search
                </button>
              )}
            </div>
          </form>
          {proposal && (
            <div {...stylex.props(site.proposal)}>
              <div>
                <strong>{proposal.query}</strong>
                <p {...stylex.props(site.proposalText)}>{proposal.explanation}</p>
              </div>
              <button
                type="button"
                {...stylex.props(site.proposalButton)}
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
            <div {...stylex.props(site.libraryStatus)} aria-live="polite">
              {libraryLoading ? (
                <>
                  <span {...stylex.props(site.statusDot, site.statusDotLoading)} />
                  Loading your search library…
                </>
              ) : accounts.length ? (
                <>
                  <span {...stylex.props(site.statusDot)} />
                  Select an imported account to search its posts
                </>
              ) : (
                <>
                  <span {...stylex.props(site.statusDot, site.statusDotMuted)} />
                  Connect your sources to start searching.
                  <button
                    type="button"
                    {...stylex.props(site.textButton, site.libraryStatusButton)}
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
          <div {...stylex.props(site.notice)} role="status">
            <span>{notice}</span>
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={() => setNotice("")}
              {...stylex.props(site.iconButton)}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {reading && (
          <div {...stylex.props(site.notice)} role="status">
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
            onBookmark={(post) => void task(() => runBookmark(post))}
            onThread={(post) => void task(() => runThread(post.url))}
          />
        )}
      </main>
      <footer {...stylex.props(site.siteFooter)}>
        <span {...stylex.props(site.siteFooterTagline)}>Find the words. Keep the context.</span>
        <div {...stylex.props(site.siteFooterLinks)}>
          <a
            href="https://mdfromx.com"
            target="_blank"
            rel="noreferrer"
            {...stylex.props(site.siteFooterLink)}
          >
            Powered by x.md <ArrowUpRight size={12} />
          </a>
          {OPERATOR_BUILD && (
            <button
              type="button"
              onClick={() => setModal("setup")}
              {...stylex.props(site.siteFooterButton)}
            >
              <SlidersHorizontal size={13} />
              Connections
            </button>
          )}
        </div>
      </footer>
      {modal === "imports" && (
        <Modal notice={notice} title="Import an account" close={() => setModal(null)}>
          <p {...stylex.props(site.mutedCopy)}>
            Collect an account’s public history through x.md. Raw captures go to your data service
            for normalization and storage; this app tracks the handoff.
          </p>
          <form {...stylex.props(site.stackForm)} onSubmit={importAccount}>
            <label htmlFor="account" {...stylex.props(site.stackLabel)}>
              X handle
            </label>
            <input
              id="account"
              value={accountInput}
              onChange={(e) => setAccountInput(e.target.value)}
              placeholder="@handle"
              required
              maxLength={16}
            />
            <label htmlFor="since" {...stylex.props(site.stackLabel)}>
              History since{" "}
              <small {...stylex.props(site.stackLabelNote)}>Optional, YYYY-MM-DD</small>
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
              type="submit"
              disabled={busy || !configured?.indexing}
              {...stylex.props(site.primary, site.stackSubmit)}
            >
              <Download size={16} />
              Import posts
            </button>
            {configured && !configured.indexing && (
              <p {...stylex.props(site.configWarning)}>{IMPORTS_UNAVAILABLE}</p>
            )}
            {OPERATOR_BUILD && (
              <button
                type="button"
                onClick={openDashboard}
                {...stylex.props(site.textButton, site.stackTextButton)}
              >
                More options in the dashboard <ArrowUpRight size={13} />
              </button>
            )}
          </form>
          <div {...stylex.props(site.jobs)}>
            <h3 {...stylex.props(site.jobsHeading)}>Recent imports</h3>
            {!jobs.length && (
              <p {...stylex.props(site.mutedCopy)}>
                Your imports and their progress will appear here.
              </p>
            )}
            {jobs.map((job) => (
              <div {...stylex.props(site.job)} key={job._id}>
                <div {...stylex.props(site.jobRow)}>
                  <strong {...stylex.props(site.jobTitle)}>
                    {job.kind === "bulk" ? `@${job.input}` : job.input}
                  </strong>
                  <span
                    {...stylex.props(
                      site.jobStatus,
                      job.status === "complete" && site.jobStatusComplete,
                      (job.status === "failed" || job.status === "partial") && site.jobStatusFailed,
                    )}
                  >
                    {jobLabel(job)}
                  </span>
                </div>
                <p {...stylex.props(site.jobText)}>{jobSummary(job)}</p>
                {job.error && <p {...stylex.props(site.configWarning)}>{job.error}</p>}
                {jobWarnings(job).map((w) => (
                  <p {...stylex.props(site.mutedCopy)} key={w}>
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
                      {...stylex.props(site.jobButton)}
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
          <p {...stylex.props(site.mutedCopy)}>Saved privately to this browser's guest session.</p>
          {!saved.length && (
            <div {...stylex.props(site.empty, site.emptySmall)}>
              <span {...stylex.props(site.emptyIcon)}>
                <Clock3 size={26} />
              </span>
              <p {...stylex.props(site.emptyText)}>
                Run a search, then save it to come back to it.
              </p>
            </div>
          )}
          {saved.map((item) => (
            <div {...stylex.props(site.savedRow)} key={item._id}>
              <button
                type="button"
                onClick={() => {
                  search(item.query, item.sort);
                  setModal(null);
                }}
                {...stylex.props(site.savedRowOpen)}
              >
                <Search size={16} />
                {item.query}
              </button>
              <button
                type="button"
                aria-label={`Remove ${item.query}`}
                onClick={() => void task(() => runRemoveSaved(item._id))}
                {...stylex.props(site.iconButton)}
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
            <p {...stylex.props(site.mutedCopy)}>Checking your account…</p>
          ) : !verifiedEmail ? (
            <>
              <p {...stylex.props(site.mutedCopy)}>
                Sending requires a verified email address, so results only ever go to you. Search
                and every other feature stay available without one.
              </p>
              <EmailSignIn
                xstyle={site.stackForm}
                onSignedIn={() => setNotice("Signed in. You can now preview and send this digest.")}
              />
            </>
          ) : (
            <>
              <p {...stylex.props(site.mutedCopy)}>
                {emailPreview
                  ? `First ${emailPreview.rowCount} of ${emailPreview.totalCount} results for "${raw}", with original post links.`
                  : `Send the first 10 matches for "${raw}", with original post links.`}{" "}
                Sending happens only when you press the button below.
              </p>
              {emailPreview && (
                <p {...stylex.props(site.mutedCopy)}>Subject: {emailPreview.subject}</p>
              )}
              <form
                {...stylex.props(site.stackForm)}
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
                <button type="submit" disabled={busy || !sessionId} {...stylex.props(site.primary)}>
                  Send results
                </button>
              </form>
            </>
          )}
          {deliveries.map((d) => (
            <p key={d._id} {...stylex.props(site.delivery)}>
              {d.query}: {d.delivery?.status ?? "unknown"}
            </p>
          ))}
        </Modal>
      )}
      {modal === "setup" && ConnectionsPanel && (
        <Modal notice={notice} title="Connections" close={() => setModal(null)}>
          <Suspense fallback={<p {...stylex.props(site.mutedCopy)}>Loading…</p>}>
            <ConnectionsPanel />
          </Suspense>
        </Modal>
      )}
      {page && (
        <Modal title={page.title} close={() => setPage(null)}>
          <p {...stylex.props(site.mutedCopy)}>
            Collected {new Date(page.collectedAt).toLocaleString()}
          </p>
          <p {...stylex.props(site.pageText)}>{page.text}</p>
          <a href={page.url} target="_blank" rel="noreferrer" {...stylex.props(site.sourceLink)}>
            <ExternalLink size={14} />
            Open original page
          </a>
        </Modal>
      )}
      {contextPages &&
        (contextPages.length ? (
          <Modal title="Web context" close={() => setContextPages(null)}>
            {contextPages.map((p) => (
              <div {...stylex.props(site.pageText, site.pageBlock)} key={p.url}>
                <strong>{p.title}</strong>
                <p>{p.text}</p>
              </div>
            ))}
          </Modal>
        ) : (
          <Modal title="Web context" close={() => setContextPages(null)}>
            <p {...stylex.props(site.mutedCopy)}>No linked pages found for this search.</p>
          </Modal>
        ))}
    </div>
  );
}
