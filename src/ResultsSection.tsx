import { useDeferredValue, useState } from "react";
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
import type { Doc } from "../convex/_generated/dataModel";
import { keyLinkifySegments, linkifyText } from "./linkify";
import type { ResultPost } from "../convex/lib/results";
import type { Sort } from "../convex/lib/search";
import { NerdStatsPanel } from "./library/NerdStatsPanel";
import { OPERATOR_BUILD } from "./operatorSurface";
import type { SearchAttemptSnapshot } from "./searchTelemetry";
import { ModalKind, ViewMode } from "./uiState";

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
  threadStatus,
}: {
  post: ResultPost;
  query: string;
  bookmarked: boolean;
  onBookmark: () => void;
  onThread: () => void;
  onRead: (url: string) => void;
  onAuthor: () => void;
  threadStatus?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const createdAt = post.createdAt === undefined ? null : new Date(post.createdAt);
  const hasValidDate = createdAt !== null && !Number.isNaN(createdAt.getTime());
  const trimmedText = post.text.trim();
  const displayText =
    !expanded && trimmedText.length > 700 ? `${trimmedText.slice(0, 700)}…` : trimmedText;
  const keyedSegments = keyLinkifySegments(trimmedText ? linkifyText(displayText) : []);
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
      {trimmedText ? (
        <p className="post-text">
          {keyedSegments.map(({ key, segment }) =>
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
              <Highlight key={key} text={segment.value} query={query} />
            ),
          )}
        </p>
      ) : (
        // x.md's search API doesn't carry a media field (convex/lib/results.ts
        // `resultPost` has no image/video property), so an empty `text` is
        // the only signal a media-only post gives us. Say so honestly rather
        // than rendering a blank card or inventing a thumbnail we can't back.
        <p className="post-text muted-copy">
          📷 Media post — text wasn't captured. Open on X to view it.
        </p>
      )}
      {trimmedText.length > 700 && (
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
          {/* This fetches the conversation from X (a real x.md job), it
              doesn't open a preview — the label says so, and the status
              line below tracks the job it starts instead of only surfacing
              it in the Recent imports modal. */}
          <button type="button" onClick={onThread}>
            Fetch conversation from X
          </button>
          <a href={post.url} target="_blank" rel="noreferrer">
            Open on X <ArrowUpRight size={14} />
          </a>
        </div>
        {threadStatus && (
          <p className="scope-note" role="status">
            {threadStatus}
          </p>
        )}
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
  liveImportStatus,
  threadStatus,
  frontendStats,
  searchPending,
}: {
  view: ViewMode;
  raw: string;
  configured: FunctionReturnType<typeof api.integrations.configured> | undefined;
  result: SessionResult | undefined;
  queryError: string;
  visible: ResultPost[];
  bookmarkedIds: Set<string>;
  busy: boolean;
  onSearch: (query: string, nextSort?: Sort) => void;
  onSave: () => void;
  onOpenModal: (modal: ModalKind) => void;
  onRetry: () => void;
  onLiveSearch: () => void;
  onWebContext: () => void;
  onLoadMore: () => void;
  onRead: (url: string) => void;
  onBookmark: (post: ResultPost) => void;
  onThread: (post: ResultPost) => void;
  /** Inline status for the header-level "Import from X" job, if one is running/finished. */
  liveImportStatus?: string | null;
  /** Inline status for a specific post's "Fetch conversation from X" job, if one is running/finished. */
  threadStatus?: (tweetId: string) => string | null | undefined;
  frontendStats?: SearchAttemptSnapshot | null;
  searchPending?: boolean;
}) {
  // Effect-free focus/scroll: callback ref runs at commit time, no useEffect.
  function resultsTitleRef(node: HTMLHeadingElement | null) {
    if (!node || view !== ViewMode.Bookmarks) return;
    node.scrollIntoView({ block: "start" });
    node.focus({ preventScroll: true });
  }

  const deferredVisible = useDeferredValue(visible);

  return (
    <section className="results">
      <header className="results-header">
        <div>
          <h1 ref={resultsTitleRef} tabIndex={-1}>
            {view === ViewMode.Bookmarks ? "Bookmarks" : raw}
          </h1>
          <p>
            {view === ViewMode.Bookmarks
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
        {view === ViewMode.Search && (
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
              onClick={() => onOpenModal(ModalKind.Email)}
            >
              <Mail size={15} />
              Email
            </button>
            {/* This starts a real x.md fetch against X, not a preview — the
                label says so, and the status line below tracks the job
                instead of only surfacing it in the Recent imports modal. */}
            <button type="button" disabled={busy || !configured?.indexing} onClick={onLiveSearch}>
              <Search size={15} />
              Import from X
            </button>
          </div>
        )}
      </header>
      {view === ViewMode.Search && liveImportStatus && (
        <p className="scope-note" role="status">
          {liveImportStatus}
        </p>
      )}
      {queryError ? (
        <div className="empty">
          <h2>Adjust your search</h2>
          <p>{queryError}</p>
        </div>
      ) : view === ViewMode.Search && configured === undefined ? (
        <div className="empty" role="status">
          Checking your connections…
        </div>
      ) : view === ViewMode.Search && configured?.search === false ? (
        <div className="empty">
          <Search size={30} />
          <h2>Search is not available on this site.</h2>
          <p>The interface is ready. Your data service supplies the corpus and search results.</p>
          {OPERATOR_BUILD && (
            <button type="button" onClick={() => onOpenModal(ModalKind.Setup)}>
              View connections
            </button>
          )}
        </div>
      ) : result?.status === "failed" ? (
        <div className="empty">
          <h2>Search could not complete</h2>
          <p>{result.error}</p>
          <button type="button" onClick={onRetry} disabled={busy}>
            Retry search
          </button>
        </div>
      ) : view === ViewMode.Search && (!result || result.status !== "complete") ? (
        <div className="empty" role="status">
          Finding matching posts…
        </div>
      ) : !visible.length ? (
        <div className="empty">
          <Search size={30} />
          <h2>
            {view === ViewMode.Bookmarks
              ? "Keep the posts worth finding again."
              : "No matches in your library yet."}
          </h2>
          <p>
            {view === ViewMode.Bookmarks
              ? "Use the bookmark button on any result."
              : "Import an account's history, try fewer keywords, or find more posts on X."}
          </p>
          {view === ViewMode.Search && (
            <button type="button" onClick={() => onOpenModal(ModalKind.Imports)}>
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
          {(result?.stats || frontendStats) && (
            <NerdStatsPanel frontend={frontendStats ?? null} result={result} />
          )}
          {searchPending && (
            <p className="scope-note" role="status">
              Updating results…
            </p>
          )}
          <div className="post-list">
            {deferredVisible.map((post) => (
              <PostCard
                key={post.tweetId}
                post={post}
                query={raw}
                bookmarked={bookmarkedIds.has(post.tweetId)}
                onAuthor={() => onSearch(`@${post.author}`)}
                onBookmark={() => onBookmark(post)}
                onThread={() => onThread(post)}
                onRead={onRead}
                threadStatus={threadStatus?.(post.tweetId)}
              />
            ))}
          </div>
          {view === ViewMode.Search && result?.nextCursor && (
            <button type="button" className="load-more" disabled={busy} onClick={onLoadMore}>
              Load more
            </button>
          )}
        </>
      )}
    </section>
  );
}
