import { useEffect, useRef, useState } from "react";
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

export function Avatar({ name, url }: { name: string; url?: string }) {
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
    <article className="post">
      <header>
        <button type="button" className="author" onClick={onAuthor}>
          <Avatar name={post.author} url={post.avatar} />
          <span>
            <strong>{post.displayName ?? post.author}</strong>
            <small>@{post.author}</small>
          </span>
        </button>
        <div className="post-meta">
          {hasValidDate ? (
            <time dateTime={createdAt.toISOString()}>{postDateTime.format(createdAt)}</time>
          ) : null}
          <button
            type="button"
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
        <button type="button" className="text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Read full post"}
        </button>
      )}
      {post.links.length > 0 && (
        <div className="links">
          {post.links.slice(0, 3).map((url) => (
            <button type="button" key={url} onClick={() => onRead(url)} title={url}>
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
          <button type="button" onClick={onThread}>
            Conversation
          </button>
          <a href={post.url} target="_blank" rel="noreferrer">
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
    <section className="results">
      <header className="results-header">
        <div>
          <h1 ref={resultsTitle} tabIndex={-1}>
            {view === "bookmarks" ? "Bookmarks" : raw}
          </h1>
          <p>
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
          <div className="result-tools">
            <button
              type="button"
              title="Save search"
              disabled={busy || !!queryError}
              onClick={onSave}
            >
              <Bookmark size={15} />
              Save search
            </button>
            <button type="button" disabled={busy || !configured?.firecrawl} onClick={onWebContext}>
              <Link2 size={15} />
              Web context
            </button>
            <button
              type="button"
              title="Email top results"
              disabled={!visible.length || !configured?.email}
              onClick={() => onOpenModal("email")}
            >
              <Mail size={15} />
              Email
            </button>
            <button type="button" disabled={busy || !configured?.indexing} onClick={onLiveSearch}>
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
          <h2>Search is unavailable right now.</h2>
          <p>The interface is ready. Your data service supplies the corpus and search results.</p>
          {/* The Connections panel exists only in the operator build, so in
              the public one this button opened a modal that renders nothing.
              A visitor cannot connect a search service anyway — that is an
              operator's job — so the public copy no longer asks them to. */}
          {OPERATOR_BUILD && (
            <button type="button" onClick={() => onOpenModal("setup")}>
              View connections
            </button>
          )}
        </div>
      ) : result?.status === "failed" ? (
        <div className="empty">
          <h2>Search could not complete</h2>
          <p>{result.error}</p>
          <button type="button" onClick={onRetry}>
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
            <button type="button" onClick={() => onOpenModal("imports")}>
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
                  {result.stats.backend.indexDocs} docs / {result.stats.backend.segments} segments
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
                bookmarked={bookmarkedIds.has(post.tweetId)}
                onAuthor={() => onSearch(`@${post.author}`)}
                onBookmark={() => onBookmark(post)}
                onThread={() => onThread(post)}
                onRead={onRead}
              />
            ))}
          </div>
          {view === "search" && result?.nextCursor && (
            <button type="button" className="load-more" disabled={busy} onClick={onLoadMore}>
              Next page
            </button>
          )}
        </>
      )}
    </section>
  );
}
