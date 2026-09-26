import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import type { ResultPost } from "../convex/lib/results";
import { linkifyText, truncateSegments } from "./linkify";
import { NerdStatsPanel } from "./library/NerdStatsPanel";
import { OPERATOR_BUILD } from "./operatorBuild";
import type { SearchAttemptSnapshot } from "./searchTelemetry";
import { ModalKind, ViewMode } from "./uiState";
import { sortLabel } from "./sortOptions";
import type { Sort } from "../convex/lib/search";
import { Avatar } from "./Avatar";
import { Icon } from "./icons";
import { compact, postDate, safeHostname } from "./format";
import { ringAvatarUrl } from "./avatarUrl";
import { PostEmbeds, QuotedBy, replyText } from "./PostEmbeds";
import { highlightParts } from "./highlight";
import type { Account } from "./Wall";
import { parseQuery } from "../convex/lib/search";
import { capture, redactEmail } from "./posthog";

type SessionResult = Doc<"sessions">;

type Configured = FunctionReturnType<typeof api.integrations.configured>;

/** Characters shown before "Read full post". */
const PREVIEW_CHARS = 700;

function Highlight(props: { text: string; query: string }) {
  return (
    <For each={highlightParts(props.text, props.query)}>
      {(part) => (part.mark ? <mark>{part.text}</mark> : part.text)}
    </For>
  );
}

export function PostRow(props: {
  post: ResultPost;
  index: number;
  query: string;
  bookmarked: boolean;
  onBookmark: () => void;
  onAuthor: () => void;
  onThread: () => void;
  onRead: (url: string) => void;
  threadStatus?: string | null;
  /** `undefined` while the operator check loads. Operator-only actions
   * (fetching a conversation or a linked page from a paid provider) render
   * only for a confirmed operator — on the public site they cannot run. */
  isOperator: boolean | undefined;
  /** Avatar for an author whose row carries none (older imports stored the
   * post without one); the imported account still knows it. */
  avatarFor?: (handle: string) => string | undefined;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const text = () => replyText(props.post.text, props.post.replyTo).trim();
  const hasEmbeds = () => !!(props.post.media?.length || props.post.card || props.post.quote);
  const long = () => text().length > PREVIEW_CHARS;

  // Linkify the full text first, then truncate the *segments*: slicing the
  // raw string first can cut a URL in half and link to a broken address.
  const segments = () => {
    const all = text() ? linkifyText(text()) : [];

    return long() && !expanded() ? truncateSegments(all, PREVIEW_CHARS) : all;
  };

  const date = () => postDate(props.post.createdAt);

  return (
    <article class="r" style={{ "--n": String(Math.min(props.index, 8)) }}>
      <button
        type="button"
        class="r-av"
        aria-label={`Search @${props.post.author}`}
        onClick={() => props.onAuthor()}
      >
        <Avatar
          name={props.post.author}
          url={props.post.avatar ?? props.avatarFor?.(props.post.author)}
        />
      </button>
      <div>
        <div class="rt">
          <b>{props.post.displayName ?? props.post.author}</b>@{props.post.author}
          <Show when={date()}>
            {(d) => (
              <>
                {" · "}
                <time datetime={new Date(props.post.createdAt!).toISOString()}>{d()}</time>
              </>
            )}
          </Show>
        </div>
        <Show when={props.post.replyTo && props.post.replyTo !== props.post.author}>
          <div class="r-reply">Replying to @{props.post.replyTo}</div>
        </Show>
        <Show
          when={text()}
          fallback={
            // Posts indexed before the search service kept media carry
            // none, so an empty text with nothing to embed is a media post
            // we can't show. Say so rather than render a blank row.
            <Show when={!hasEmbeds()}>
              <p class="muted-copy">
                Media post — its media wasn't captured. Open it on X to see it.
              </p>
            </Show>
          }
        >
          <p>
            <For each={segments()}>
              {(segment) =>
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
                  <Highlight text={segment.value} query={props.query} />
                )
              }
            </For>
          </p>
        </Show>
        <Show when={long()}>
          <button type="button" class="text-button" onClick={() => setExpanded(!expanded())}>
            {expanded() ? "Show less" : "Read full post"}
          </button>
        </Show>
        <PostEmbeds post={props.post} />
        <Show when={props.isOperator && props.post.links.length}>
          <div class="links">
            <For each={props.post.links.slice(0, 3)}>
              {(url) => (
                <button type="button" title={url} onClick={() => props.onRead(url)}>
                  <Icon name="link" size={14} />
                  <span>{safeHostname(url)}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="rf">
          <Show when={props.post.replies !== undefined}>
            <span class="m" title="Replies at collection time">
              <Icon name="message-circle" />
              {compact(props.post.replies!)}
              <span class="sr"> replies</span>
            </span>
          </Show>
          <Show when={props.post.reposts !== undefined}>
            <span class="m" title="Reposts at collection time">
              <Icon name="repeat-2" />
              {compact(props.post.reposts!)}
              <span class="sr"> reposts</span>
            </span>
          </Show>
          <Show when={props.post.likes !== undefined}>
            <span class="m" title="Likes at collection time">
              <Icon name="heart" />
              {compact(props.post.likes!)}
              <span class="sr"> likes</span>
            </span>
          </Show>
          <span class="end">
            <button
              type="button"
              class="bm"
              aria-pressed={props.bookmarked ? "true" : "false"}
              aria-label={props.bookmarked ? "Remove bookmark" : "Bookmark post"}
              onClick={() => props.onBookmark()}
            >
              <Icon name="bookmark" />
            </button>
            <Show when={props.isOperator}>
              <button type="button" class="out" onClick={() => props.onThread()}>
                Fetch conversation
              </button>
            </Show>
            <a
              class="out"
              href={props.post.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                capture("result_opened", {
                  query: redactEmail(props.query),
                  result_url: redactEmail(props.post.url),
                });
                capture("search_success", { method: "opened", query: redactEmail(props.query) });
              }}
            >
              Open on X
              <Icon name="arrow-up-right" size={14} />
            </a>
          </span>
        </div>
        <QuotedBy post={props.post} />
        <Show when={props.threadStatus}>
          <p class="scope-note" role="status">
            {props.threadStatus}
          </p>
        </Show>
      </div>
    </article>
  );
}

/**
 * The row above the search form on the results view: back, what is being
 * searched (an account's face and name when the query is scoped to one),
 * and the tools that act on it — save, copy link, and a small menu for the
 * rest. Provider-spending tools render only for a confirmed operator: on
 * the public site they cannot run, so they are not offered there.
 */
export function ResultsHead(props: {
  view: ViewMode;
  raw: string;
  account: Account | undefined;
  alreadySaved: boolean;
  /** Briefly true after saving, for the tick. */
  justSaved?: boolean;
  /** Briefly true after copying the link, for the tick. */
  copied?: boolean;
  busy: boolean;
  queryError: string;
  hasUsableResults: boolean;
  configured: Configured | undefined;
  isOperator: boolean | undefined;
  emailNeedsSignIn: boolean;
  onBack: () => void;
  onSave: () => void;
  onCopy: () => void;
  onEmail: () => void;
  onWebContext: () => void;
  onLiveSearch: () => void;
}) {
  const scope = () => {
    try {
      return parseQuery(props.raw);
    } catch {
      return null;
    }
  };

  return (
    <div class="rhead">
      <button
        type="button"
        class="ib"
        aria-label="Back to all accounts"
        onClick={() => props.onBack()}
      >
        <Icon name="chevron-left" />
      </button>
      <div class="ident">
        <Switch
          fallback={
            <h1 class="qtitle">
              {scope()?.text
                ? `“${scope()?.text}”`
                : scope()?.author
                  ? `@${scope()?.author}`
                  : props.raw}
            </h1>
          }
        >
          <Match when={props.view === ViewMode.Bookmarks}>
            <BookmarksTitle />
          </Match>
          <Match when={props.account}>
            {(account) => (
              <>
                <Avatar name={account().handle} url={ringAvatarUrl(account().avatar)} />
                <div>
                  <h1>{account().name || `@${account().handle}`}</h1>
                  <span>
                    @{account().handle}
                    <Show when={scope()?.text}>{` · “${scope()?.text}”`}</Show>
                  </span>
                </div>
              </>
            )}
          </Match>
        </Switch>
      </div>
      <Show when={props.view === ViewMode.Search}>
        <button
          type="button"
          class={["ib", { saved: props.alreadySaved, done: !!props.justSaved }]}
          aria-pressed={props.alreadySaved ? "true" : "false"}
          aria-label={props.alreadySaved ? "Remove saved search" : "Save search"}
          title={props.alreadySaved ? "Remove saved search" : "Save search"}
          disabled={props.busy || !!props.queryError}
          onClick={() => props.onSave()}
        >
          <span class="swap">
            <Icon name="bookmark" class="a" />
            <Icon name="check" class="b" />
          </span>
        </button>
      </Show>
      <button
        type="button"
        class={["ib", { done: !!props.copied }]}
        aria-label={props.copied ? "Link copied" : "Copy link"}
        title="Copy link"
        onClick={() => props.onCopy()}
      >
        <span class="swap">
          <Icon name="copy" class="a" />
          <Icon name="check" class="b" />
        </span>
      </button>
      {/* Email, Web context and Import from X act on the current results,
          so they're meaningless without any (an invalid query, a failed
          search, zero matches — QA A7/B4). */}
      <Show when={props.hasUsableResults}>
        <details class="more">
          <summary class="ib" aria-label="More actions" title="More actions">
            <Icon name="ellipsis" />
          </summary>
          <div class="pop more-pop">
            <button
              type="button"
              disabled={!props.configured?.email}
              onClick={() => props.onEmail()}
            >
              <Icon name="mail" />
              {props.emailNeedsSignIn ? "Email · sign in" : "Email these results"}
            </button>
            {/* `undefined` is still loading, not "not set up": the button
                stays disabled then, but only a real `false` says so. */}
            <Show when={props.configured?.email === false}>
              <p>Email isn't set up on this deployment.</p>
            </Show>
            <Show when={props.isOperator}>
              <button
                type="button"
                disabled={props.busy || !props.configured?.firecrawl}
                onClick={() => props.onWebContext()}
              >
                <Icon name="link" />
                Web context (fetches pages)
              </button>
              <button
                type="button"
                disabled={props.busy || !props.configured?.indexing}
                onClick={() => props.onLiveSearch()}
              >
                <Icon name="search" />
                Import from X
              </button>
            </Show>
          </div>
        </details>
      </Show>
    </div>
  );
}

export interface ResultsSectionProps {
  view: ViewMode;
  raw: string;
  sort: Sort;
  configured: Configured | undefined;
  result: SessionResult | undefined;
  queryError: string;
  visible: ResultPost[];
  /** How many posts the search matches in all, when the service says. */
  total?: number;
  bookmarkedIds: Set<string>;
  busy: boolean;
  /** An `@handle` the query filters to that isn't among the imported accounts. */
  unknownAuthor?: string;
  onSearch: (query: string, nextSort?: Sort) => void;
  onOpenModal: (modal: ModalKind) => void;
  onImportAccount: (handle: string) => void;
  onRetry: () => void;
  onLiveSearch: () => void;
  onLoadMore: () => void;
  onRead: (url: string) => void;
  onBookmark: (post: ResultPost) => void;
  onThread: (post: ResultPost) => void;
  /** Inline status for the header-level "Import from X" job, if one is running/finished. */
  liveImportStatus?: string | null;
  /** Inline status for a specific post's "Fetch conversation" job. */
  threadStatus?: (tweetId: string) => string | null | undefined;
  frontendStats?: SearchAttemptSnapshot | null;
  statsForNerds?: boolean;
  /** `undefined` while the operator check is loading. */
  isOperator: boolean | undefined;
  avatarFor?: (handle: string) => string | undefined;
}

export function ResultsSection(props: ResultsSectionProps) {
  const searchView = () => props.view === ViewMode.Search;
  const failed = () => props.result?.status === "failed";
  const complete = () => props.result?.status === "complete";

  // Stats belong to the search *attempt*, not to having matches: a
  // completed zero-match search still ran, and its timings are exactly what
  // "stats for nerds" is for.
  const showStats = () =>
    searchView() &&
    !props.queryError &&
    complete() &&
    props.statsForNerds &&
    (props.result?.stats || props.frontendStats);

  // "43 posts" once everything is on screen, "20 of 43 posts" before; a
  // page from an older search service has no total, so only say what loaded.
  const count = () => {
    const shown = props.visible.length;
    const total = props.total;

    if (total === undefined || total < shown)
      return `${shown} ${shown === 1 ? "post" : "posts"} loaded`;
    const noun = total === 1 ? "post" : "posts";

    return total === shown
      ? `${total.toLocaleString()} ${noun}`
      : `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`;
  };

  return (
    <section class="results" aria-live="polite">
      <Show when={searchView() && props.liveImportStatus}>
        <p class="scope-note" role="status">
          {props.liveImportStatus}
        </p>
      </Show>
      <Switch>
        <Match when={props.queryError}>
          <div class="empty" role="alert">
            <h2>Adjust your search</h2>
            <p>{props.queryError}</p>
          </div>
        </Match>
        <Match when={searchView() && props.configured === undefined}>
          {/* `configured` is a read of which services are set up, not a
              connectivity probe: "we haven't asked yet", nothing more. */}
          <div class="empty" role="status">
            <p>Checking configuration…</p>
          </div>
        </Match>
        <Match when={searchView() && props.configured?.search === false}>
          <div class="empty">
            <h2>Search isn't configured on this site.</h2>
            <p>Search needs the search service to be configured for this site.</p>
            <Show when={OPERATOR_BUILD}>
              <button type="button" class="imp" onClick={() => props.onOpenModal(ModalKind.Setup)}>
                View connections
              </button>
            </Show>
          </div>
        </Match>
        <Match when={failed()}>
          <div class="empty">
            <h2>Search could not complete</h2>
            <p>{props.result?.error}</p>
            <button type="button" class="imp" onClick={() => props.onRetry()} disabled={props.busy}>
              Retry search
            </button>
          </div>
        </Match>
        {/* Only while nothing is loaded: "Load more" keeps the rows it
            already has on screen while its page is found. */}
        <Match when={searchView() && !complete() && !props.visible.length}>
          <div class="rcount" role="status">
            Finding matching posts…
          </div>
        </Match>
        <Match when={!props.visible.length}>
          <Switch>
            <Match when={!searchView()}>
              <div class="empty">
                <h2>No bookmarks yet</h2>
                <p>Press the bookmark icon under any post to keep it here.</p>
              </div>
            </Match>
            <Match when={props.unknownAuthor}>
              {(handle) => (
                <div class="empty">
                  <h2>@{handle()} isn’t imported yet</h2>
                  <p>Import the account to search its posts here.</p>
                  <button type="button" class="imp" onClick={() => props.onImportAccount(handle())}>
                    <Icon name="plus" />
                    Import @{handle()}
                  </button>
                </div>
              )}
            </Match>
            <Match when={true}>
              <div class="empty">
                <h2>No matches in the indexed accounts yet.</h2>
                <p>Try fewer keywords, or import an account's history.</p>
                <div class="empty-actions">
                  <button
                    type="button"
                    class="imp"
                    onClick={() => props.onOpenModal(ModalKind.Imports)}
                  >
                    <Icon name="plus" />
                    Import an account
                  </button>
                  {/* Fetches from X with the current query — a paid x.md
                      job, so only offered where it can actually run. */}
                  <Show when={props.isOperator && props.configured?.indexing}>
                    <button
                      type="button"
                      class="imp"
                      disabled={props.busy}
                      onClick={() => props.onLiveSearch()}
                    >
                      <Icon name="search" />
                      Import from X
                    </button>
                  </Show>
                </div>
              </div>
            </Match>
          </Switch>
        </Match>
        <Match when={true}>
          <div class="rcount">
            {searchView()
              ? count()
              : `${props.bookmarkedIds.size} saved ${props.bookmarkedIds.size === 1 ? "post" : "posts"} in this browser's session`}
            <Show when={searchView() && props.statsForNerds}>
              {" · "}
              {sortLabel(props.sort).toLowerCase()}
            </Show>
          </div>
          <For each={props.visible} keyed={(post) => post.tweetId}>
            {(post, i) => (
              <PostRow
                post={post()}
                index={i()}
                query={props.raw}
                bookmarked={props.bookmarkedIds.has(post().tweetId)}
                onAuthor={() => props.onSearch(`@${post().author}`)}
                onBookmark={() => props.onBookmark(post())}
                onThread={() => props.onThread(post())}
                onRead={props.onRead}
                threadStatus={props.threadStatus?.(post().tweetId)}
                isOperator={props.isOperator}
                avatarFor={props.avatarFor}
              />
            )}
          </For>
          <Show when={searchView() && !complete()}>
            <div class="rcount" role="status">
              Finding more posts…
            </div>
          </Show>
          <Show when={searchView() && props.result?.nextCursor}>
            <button
              type="button"
              class="imp load-more"
              disabled={props.busy}
              onClick={() => props.onLoadMore()}
            >
              Load more
            </button>
          </Show>
          <p class="scope-note">
            {searchView()
              ? "Engagement counts were captured when each post was indexed, not live."
              : "Bookmarks are stored in this browser's session until you remove them."}
          </p>
        </Match>
      </Switch>
      <Show when={showStats()}>
        <NerdStatsPanel frontend={props.frontendStats ?? null} result={props.result} />
      </Show>
    </section>
  );
}

/** The Bookmarks view's heading, focused when the view opens so keyboard
 * and screen-reader users land on it rather than on the toggle they left. */
function BookmarksTitle() {
  let title!: HTMLHeadingElement;

  onSettled(() => title.focus({ preventScroll: true }));

  return (
    <h1
      ref={(el) => {
        title = el;
      }}
      class="qtitle"
      tabindex="-1"
    >
      Bookmarks
    </h1>
  );
}
