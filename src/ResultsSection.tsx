import { useEffect, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  ArrowUpRight,
  Bookmark,
  Heart,
  Link2,
  Mail,
  MessageCircle,
  Plus,
  Repeat2,
  Search,
} from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import { OPERATOR_BUILD } from "./operatorSurface";
import type { Doc } from "../convex/_generated/dataModel";
import type { ResultPost } from "../convex/lib/results";
import type { Sort } from "../convex/lib/search";
import { formatDuration } from "./library/format";

type SessionResult = Doc<"sessions">;

const styles = stylex.create({
  avatar: {
    width: 40,
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    overflow: "hidden",
    color: "#cbbdab",
    backgroundColor: "#24211d",
    fontSize: 12,
    flexShrink: 0,
  },
  avatarImg: {
    height: "100%",
    width: "100%",
    objectFit: "cover",
  },
  avatarLarge: {
    height: 46,
    width: 46,
    "@media (max-width: 1100px)": {
      height: 36,
      width: 36,
    },
  },
  post: {
    paddingTop: 26,
    paddingBottom: 26,
    borderBottom: "1px solid var(--line)",
  },
  postHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  author: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: 0,
    borderWidth: 0,
    textAlign: "left",
  },
  authorText: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  authorName: {
    fontSize: 13,
    fontWeight: 550,
  },
  authorHandle: {
    fontSize: 12,
    color: "#8b8883",
  },
  postMeta: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    color: "#8b8883",
    fontSize: 11,
    "@media (max-width: 700px)": {
      gap: 3,
      fontSize: 10,
    },
  },
  postMetaTime: {
    "@media (max-width: 700px)": {
      maxWidth: 70,
      textAlign: "right",
    },
  },
  iconButton: {
    padding: 7,
    borderColor: "transparent",
    flexShrink: 0,
  },
  accent: {
    color: "var(--accent)",
  },
  postText: {
    fontSize: 15,
    lineHeight: 1.8,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    marginTop: 18,
    marginBottom: 18,
    maxWidth: "85ch",
    color: "#d1ceca",
    "@media (max-width: 700px)": {
      fontSize: 14,
      lineHeight: 1.75,
    },
  },
  textButton: {
    borderWidth: 0,
    padding: 0,
    fontSize: 13,
    color: "var(--accent)",
    borderRadius: 0,
  },
  links: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 16,
    marginBottom: 16,
  },
  linkButton: {
    fontSize: 11,
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 11,
    paddingRight: 11,
    color: "#b6a999",
    backgroundColor: "#141210",
  },
  postFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 20,
    gap: 10,
  },
  metrics: {
    display: "flex",
    gap: 20,
    color: "#85817c",
    fontSize: 11,
    "@media (max-width: 700px)": {
      gap: 12,
    },
  },
  metric: {
    display: "inline-flex",
    gap: 7,
    alignItems: "center",
  },
  postActions: {
    display: "flex",
    gap: 16,
    alignItems: "center",
    fontSize: 11,
    color: "#a4a09a",
    "@media (max-width: 700px)": {
      gap: 10,
    },
  },
  postActionButton: {
    padding: 0,
    borderWidth: 0,
    fontSize: 11,
  },
  postActionLink: {
    display: "inline-flex",
    gap: 4,
    alignItems: "center",
  },
  results: {
    maxWidth: 1044,
    marginTop: 46,
    marginBottom: 50,
    marginLeft: "auto",
    marginRight: "auto",
    "@media (max-width: 1100px)": {
      marginLeft: 28,
      marginRight: 28,
    },
    "@media (max-width: 700px)": {
      marginTop: 32,
      marginBottom: 32,
      marginLeft: 20,
      marginRight: 20,
    },
  },
  resultsHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 20,
    alignItems: "center",
    paddingBottom: 20,
    borderBottom: "1px solid var(--line)",
    "@media (max-width: 700px)": {
      flexDirection: "column",
      alignItems: "flex-start",
      gap: 18,
    },
  },
  resultsTitle: {
    fontSize: 22,
    fontWeight: 500,
    letterSpacing: "-0.6px",
    marginBottom: 7,
    overflowWrap: "anywhere",
    ":focus": {
      outline: `3px solid ${"var(--accent)"}`,
      outlineOffset: 6,
      borderRadius: 4,
    },
  },
  resultsSubtitle: {
    fontSize: 12,
    color: "var(--muted)",
    margin: 0,
  },
  resultTools: {
    display: "flex",
    gap: 7,
    flexShrink: 0,
    "@media (max-width: 700px)": {
      flexWrap: "wrap",
    },
  },
  resultToolButton: {
    fontSize: 11,
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 10,
    paddingRight: 10,
  },
  scopeNote: {
    fontSize: 11,
    color: "#72706b",
    marginTop: 14,
    marginBottom: 12,
    "@media (max-width: 700px)": {
      fontSize: 10,
      lineHeight: 1.7,
    },
  },
  statsPanel: {
    marginTop: 14,
    marginBottom: 18,
    border: "1px solid var(--line)",
    borderRadius: 8,
    color: "var(--muted)",
    fontSize: 11,
  },
  statsSummary: {
    paddingTop: 9,
    paddingBottom: 9,
    paddingLeft: 11,
    paddingRight: 11,
    color: "#c8c3bc",
    cursor: "pointer",
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(130px, 1fr) auto",
    gap: "5px 14px",
    paddingTop: 0,
    paddingBottom: 11,
    paddingLeft: 11,
    paddingRight: 11,
  },
  statsSection: {
    gridColumn: "1 / -1",
    marginTop: 5,
    color: "var(--accent)",
    fontWeight: 600,
  },
  statsLabel: {
    textAlign: "left",
  },
  statsValue: {
    textAlign: "right",
    color: "#d7d1ca",
  },
  empty: {
    textAlign: "center",
    display: "flex",
    alignItems: "center",
    flexDirection: "column",
    paddingTop: 65,
    paddingBottom: 80,
    paddingLeft: 20,
    paddingRight: 20,
    color: "#a29e98",
  },
  emptySmall: {
    paddingTop: 24,
    paddingBottom: 24,
    paddingLeft: 10,
    paddingRight: 10,
  },
  emptyIcon: {
    color: "#bda58a",
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 21,
    color: "#d0cbc4",
    fontWeight: 450,
    letterSpacing: "-0.5px",
  },
  emptyText: {
    fontSize: 13,
    maxWidth: "46ch",
  },
  emptyButton: {
    marginTop: 10,
  },
  loadMore: {
    display: "flex",
    marginTop: 30,
    marginBottom: 30,
    marginLeft: "auto",
    marginRight: "auto",
  },
});

export function Avatar({ name, url, large }: { name: string; url?: string; large?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <span {...stylex.props(styles.avatar, large && styles.avatarLarge)}>
      {url && url !== failedUrl ? (
        <img
          {...stylex.props(styles.avatarImg)}
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

export function Highlight({ text, query }: { text: string; query: string }) {
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

export function PostCard({
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
    <article {...stylex.props(styles.post)}>
      <header {...stylex.props(styles.postHeader)}>
        <button type="button" {...stylex.props(styles.author)} onClick={onAuthor}>
          <Avatar name={post.author} url={post.avatar} />
          <span {...stylex.props(styles.authorText)}>
            <strong {...stylex.props(styles.authorName)}>{post.displayName ?? post.author}</strong>
            <small {...stylex.props(styles.authorHandle)}>@{post.author}</small>
          </span>
        </button>
        <div {...stylex.props(styles.postMeta)}>
          {hasValidDate ? (
            <time dateTime={createdAt.toISOString()} {...stylex.props(styles.postMetaTime)}>
              {postDateTime.format(createdAt)}
            </time>
          ) : null}
          <button
            type="button"
            {...stylex.props(styles.iconButton, bookmarked && styles.accent)}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark post"}
            onClick={onBookmark}
          >
            <Bookmark size={17} fill={bookmarked ? "currentColor" : "none"} />
          </button>
        </div>
      </header>
      <p {...stylex.props(styles.postText)}>
        <Highlight
          text={!expanded && post.text.length > 700 ? `${post.text.slice(0, 700)}…` : post.text}
          query={query}
        />
      </p>
      {post.text.length > 700 && (
        <button
          type="button"
          {...stylex.props(styles.textButton)}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Read full post"}
        </button>
      )}
      {post.links.length > 0 && (
        <div {...stylex.props(styles.links)}>
          {post.links.slice(0, 3).map((url) => (
            <button
              type="button"
              key={url}
              {...stylex.props(styles.linkButton)}
              onClick={() => onRead(url)}
              title={url}
            >
              <Link2 size={14} />
              <span>{safeHostname(url)}</span>
              <ArrowUpRight size={13} />
            </button>
          ))}
        </div>
      )}
      <footer {...stylex.props(styles.postFooter)}>
        <div {...stylex.props(styles.metrics)}>
          {post.likes !== undefined && (
            <span title="Likes at collection time" {...stylex.props(styles.metric)}>
              <Heart size={14} />
              {compact(post.likes)}
            </span>
          )}
          {post.reposts !== undefined && (
            <span title="Reposts at collection time" {...stylex.props(styles.metric)}>
              <Repeat2 size={14} />
              {compact(post.reposts)}
            </span>
          )}
          {post.replies !== undefined && (
            <span title="Replies at collection time" {...stylex.props(styles.metric)}>
              <MessageCircle size={14} />
              {compact(post.replies)}
            </span>
          )}
        </div>
        <div {...stylex.props(styles.postActions)}>
          <button type="button" {...stylex.props(styles.postActionButton)} onClick={onThread}>
            Conversation
          </button>
          <a
            href={post.url}
            target="_blank"
            rel="noreferrer"
            {...stylex.props(styles.postActionLink)}
          >
            Open on X <ArrowUpRight size={14} />
          </a>
        </div>
      </footer>
    </article>
  );
}

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const postDateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const compact = (n: number) => compactNumber.format(n);
const safeHostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "Linked page";
  }
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span {...stylex.props(styles.statsLabel)}>{label}</span>
      <span {...stylex.props(styles.statsValue)}>{value}</span>
    </>
  );
}

export function ResultsSection({
  view,
  raw,
  configured,
  result,
  queryError,
  visible,
  bookmarkedIds,
  busy,
  onSearch,
  onSave,
  onOpenModal,
  onRetry,
  onLiveSearch,
  onWebContext,
  onLoadMore,
  onRead,
  onBookmark,
  onThread,
}: {
  view: "search" | "bookmarks";
  raw: string;
  configured: FunctionReturnType<typeof api.integrations.configured> | undefined;
  result: SessionResult | undefined;
  queryError: string;
  visible: ResultPost[];
  bookmarkedIds: Set<string>;
  busy: boolean;
  onSearch: (query: string, nextSort?: Sort) => void;
  onSave: () => void;
  onOpenModal: (modal: "imports" | "saved" | "email" | "setup") => void;
  onRetry: () => void;
  onLiveSearch: () => void;
  onWebContext: () => void;
  onLoadMore: () => void;
  onRead: (url: string) => void;
  onBookmark: (post: ResultPost) => void;
  onThread: (post: ResultPost) => void;
}) {
  const resultsTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (view !== "bookmarks") return;
    resultsTitle.current?.scrollIntoView({ block: "start" });
    resultsTitle.current?.focus({ preventScroll: true });
  }, [view]);

  return (
    <section {...stylex.props(styles.results)}>
      <header {...stylex.props(styles.resultsHeader)}>
        <div>
          <h1 ref={resultsTitle} tabIndex={-1} {...stylex.props(styles.resultsTitle)}>
            {view === "bookmarks" ? "Bookmarks" : raw}
          </h1>
          <p {...stylex.props(styles.resultsSubtitle)}>
            {view === "bookmarks"
              ? `${bookmarkedIds.size} saved posts in this browser's session`
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
          <div {...stylex.props(styles.resultTools)}>
            <button
              type="button"
              title="Save search"
              disabled={busy || !!queryError}
              onClick={onSave}
              {...stylex.props(styles.resultToolButton)}
            >
              <Bookmark size={15} />
              Save search
            </button>
            <button
              type="button"
              disabled={busy || !configured?.firecrawl}
              onClick={onWebContext}
              {...stylex.props(styles.resultToolButton)}
            >
              <Link2 size={15} />
              Web context
            </button>
            <button
              type="button"
              title="Email top results"
              disabled={!visible.length || !configured?.email}
              onClick={() => onOpenModal("email")}
              {...stylex.props(styles.resultToolButton)}
            >
              <Mail size={15} />
              Email
            </button>
            <button
              type="button"
              disabled={busy || !configured?.indexing}
              onClick={onLiveSearch}
              {...stylex.props(styles.resultToolButton)}
            >
              <Search size={15} />
              Find on X
            </button>
          </div>
        )}
      </header>
      {queryError ? (
        <div {...stylex.props(styles.empty)}>
          <h2 {...stylex.props(styles.emptyTitle)}>Adjust your search</h2>
          <p {...stylex.props(styles.emptyText)}>{queryError}</p>
        </div>
      ) : view === "search" && configured === undefined ? (
        <div {...stylex.props(styles.empty)} role="status">
          Checking your connections…
        </div>
      ) : view === "search" && configured?.search === false ? (
        <div {...stylex.props(styles.empty)}>
          <span {...stylex.props(styles.emptyIcon)}>
            <Search size={30} />
          </span>
          <h2 {...stylex.props(styles.emptyTitle)}>Search is not available on this site.</h2>
          <p {...stylex.props(styles.emptyText)}>
            The interface is ready. Your data service supplies the corpus and search results.
          </p>
          {/* The Connections panel exists only in the operator build, so in
              the public one this button opened a modal that renders nothing.
              A visitor cannot connect a search service anyway — that is an
              operator's job — so the public copy no longer asks them to. */}
          {OPERATOR_BUILD && (
            <button
              type="button"
              onClick={() => onOpenModal("setup")}
              {...stylex.props(styles.emptyButton)}
            >
              View connections
            </button>
          )}
        </div>
      ) : result?.status === "failed" ? (
        <div {...stylex.props(styles.empty)}>
          <h2 {...stylex.props(styles.emptyTitle)}>Search could not complete</h2>
          <p {...stylex.props(styles.emptyText)}>{result.error}</p>
          <button type="button" onClick={onRetry} {...stylex.props(styles.emptyButton)}>
            Retry search
          </button>
        </div>
      ) : view === "search" && (!result || result.status !== "complete") ? (
        <div {...stylex.props(styles.empty)} role="status">
          Finding matching posts…
        </div>
      ) : !visible.length ? (
        <div {...stylex.props(styles.empty)}>
          <span {...stylex.props(styles.emptyIcon)}>
            <Search size={30} />
          </span>
          <h2 {...stylex.props(styles.emptyTitle)}>
            {view === "bookmarks"
              ? "Keep the posts worth finding again."
              : "No matches in your library yet."}
          </h2>
          <p {...stylex.props(styles.emptyText)}>
            {view === "bookmarks"
              ? "Use the bookmark button on any result."
              : "Import an account's history, try fewer keywords, or find more posts on X."}
          </p>
          {view === "search" && (
            <button
              type="button"
              onClick={() => onOpenModal("imports")}
              {...stylex.props(styles.emptyButton)}
            >
              <Plus size={15} />
              Import an account
            </button>
          )}
        </div>
      ) : (
        <>
          <p {...stylex.props(styles.scopeNote)}>
            Results and ordering come from your search service. Engagement reflects the source
            snapshot.
          </p>
          {result?.stats && (
            <details {...stylex.props(styles.statsPanel)}>
              <summary {...stylex.props(styles.statsSummary)}>
                Stats for nerds —{" "}
                {formatDuration(result.stats.api?.totalUs ?? result.stats.backend.totalUs)}
              </summary>
              <div {...stylex.props(styles.statsGrid)}>
                <strong {...stylex.props(styles.statsSection)}>Backend</strong>
                <Stat label="Total" value={formatDuration(result.stats.backend.totalUs)} />
                <Stat label="Reload index" value={formatDuration(result.stats.backend.reloadUs)} />
                <Stat
                  label="Fingerprint"
                  value={formatDuration(result.stats.backend.fingerprintUs)}
                />
                <Stat
                  label="Compile query"
                  value={formatDuration(result.stats.backend.compileUs)}
                />
                <Stat label="Retrieve" value={formatDuration(result.stats.backend.retrieveUs)} />
                <Stat
                  label="Retrieve + rank candidates"
                  value={`${result.stats.backend.rankingCalls} calls`}
                />
                <Stat
                  label="Materialize rows"
                  value={formatDuration(result.stats.backend.materializeUs)}
                />
                <Stat
                  label="Hits / returned"
                  value={`${result.stats.backend.candidateHits} / ${result.stats.backend.returnedRows}`}
                />
                <Stat
                  label="Index"
                  value={`${result.stats.backend.indexDocs} docs / ${result.stats.backend.segments} segments`}
                />
                {result.stats.api && (
                  <>
                    <strong {...stylex.props(styles.statsSection)}>API</strong>
                    <Stat label="Auth" value={formatDuration(result.stats.api.authUs)} />
                    <Stat label="Parse" value={formatDuration(result.stats.api.parseUs)} />
                    <Stat label="Queue" value={formatDuration(result.stats.api.queueUs)} />
                    <Stat label="Engine wall" value={formatDuration(result.stats.api.engineUs)} />
                    <Stat
                      label="Post-process"
                      value={formatDuration(result.stats.api.postprocessUs)}
                    />
                    <Stat label="API total" value={formatDuration(result.stats.api.totalUs)} />
                  </>
                )}
              </div>
            </details>
          )}
          {result?.warnings.map((warning) => (
            <p {...stylex.props(styles.scopeNote)} key={warning}>
              {warning}
            </p>
          ))}
          <div>
            {visible.map((post) => (
              <PostCard
                key={post.tweetId}
                post={post}
                query={raw}
                bookmarked={bookmarkedIds.has(post.tweetId)}
                onAuthor={() => onSearch(`@${post.author}`)}
                onBookmark={() => onBookmark(post)}
                onThread={() => onThread(post)}
                onRead={onRead}
              />
            ))}
          </div>
          {view === "search" && result?.nextCursor && (
            <button
              type="button"
              disabled={busy}
              onClick={onLoadMore}
              {...stylex.props(styles.loadMore)}
            >
              Next page
            </button>
          )}
        </>
      )}
    </section>
  );
}
