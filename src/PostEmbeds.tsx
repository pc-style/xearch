import { For, Match, Show, Switch } from "solid-js";
import type { ResultPost } from "../convex/lib/results";
import { postDate } from "./format";

type Media = NonNullable<ResultPost["media"]>[number];

type Card = NonNullable<ResultPost["card"]>;

type Quote = NonNullable<ResultPost["quote"]>;

/**
 * X's media hosts refuse requests that carry another site's Referer (the
 * page sets `no-referrer` for videos, which cannot opt out themselves; see
 * index.html), and link-card images expire. An image that fails is hidden
 * rather than drawn broken.
 */
const hideBroken = (event: Event & { currentTarget: HTMLImageElement }) => {
  event.currentTarget.hidden = true;
};

/** Characters of a quoted post shown before it is cut off. */
const QUOTE_CHARS = 280;

/**
 * X serves every photo at several sizes; the default is the original, often
 * several megabytes. "small" (up to 680px wide) is plenty for a result row.
 */
export function sizedImage(url: string, size: "small" | "medium" = "small"): string {
  try {
    const parsed = new URL(url);

    if (parsed.hostname !== "pbs.twimg.com" || !parsed.pathname.startsWith("/media/")) return url;
    parsed.search = `?name=${size}`;

    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The text X would show for a reply: the leading @handles a reply's text
 * starts with are the reply chain, which X renders as "Replying to" instead.
 */
export function replyText(text: string, replyTo: string | undefined): string {
  return replyTo ? text.replace(/^(?:@\w{1,15}\s+)+/, "") : text;
}

function MediaItem(props: { media: Media; single: boolean; href: string }) {
  // One item keeps its own shape (so nothing jumps as it loads); several
  // share a grid and are cropped to fit it, as on X.
  const ratio = () =>
    props.single && props.media.width && props.media.height
      ? `${props.media.width} / ${props.media.height}`
      : undefined;

  return (
    <Switch>
      <Match when={props.media.kind === "photo"}>
        <a
          class="em-item"
          href={sizedImage(props.media.image, "medium")}
          target="_blank"
          rel="noopener noreferrer"
          style={{ "aspect-ratio": ratio() }}
        >
          <img
            src={sizedImage(props.media.image)}
            alt={props.media.alt ?? "Image"}
            loading="lazy"
            referrerpolicy="no-referrer"
            onError={hideBroken}
            decoding="async"
          />
        </a>
      </Match>
      <Match when={props.media.video}>
        {(video) => (
          <div class="em-item" style={{ "aspect-ratio": ratio() }}>
            {/* A GIF on X is a silent looping video; a real video waits for
                a press, and preloads nothing until then. */}
            <video
              src={video()}
              poster={props.media.image}
              aria-label={props.media.alt ?? (props.media.kind === "gif" ? "GIF" : "Video")}
              preload="none"
              playsinline
              controls={props.media.kind === "video"}
              autoplay={props.media.kind === "gif"}
              loop={props.media.kind === "gif"}
              muted={props.media.kind === "gif"}
            />
            <Show when={props.media.kind === "gif"}>
              <span class="em-badge">GIF</span>
            </Show>
          </div>
        )}
      </Match>
      <Match when={true}>
        {/* A video without a playable file: its still, linking to the post. */}
        <a
          class="em-item"
          href={props.href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ "aspect-ratio": ratio() }}
        >
          <img
            src={props.media.image}
            alt={props.media.alt ?? "Video"}
            loading="lazy"
            referrerpolicy="no-referrer"
            onError={hideBroken}
          />
          <span class="em-badge">Play on X</span>
        </a>
      </Match>
    </Switch>
  );
}

function CardEmbed(props: { card: Card }) {
  return (
    <a class="em-card" href={props.card.url} target="_blank" rel="noopener noreferrer">
      <Show when={props.card.image}>
        {(image) => (
          <img
            src={image()}
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            onError={hideBroken}
            decoding="async"
          />
        )}
      </Show>
      <span>
        <Show when={props.card.domain}>
          <small>{props.card.domain}</small>
        </Show>
        <b>{props.card.title}</b>
        <Show when={props.card.description}>
          <span class="em-desc">{props.card.description}</span>
        </Show>
      </span>
    </a>
  );
}

function QuoteEmbed(props: { quote: Quote }) {
  const date = () => postDate(props.quote.createdAt);

  const text = () =>
    props.quote.text.length > QUOTE_CHARS
      ? `${props.quote.text.slice(0, QUOTE_CHARS).trimEnd()}…`
      : props.quote.text;

  return (
    <a class="em-quote" href={props.quote.url} target="_blank" rel="noopener noreferrer">
      <span class="em-quote-by">
        <b>{props.quote.displayName ?? props.quote.author}</b> @{props.quote.author}
        <Show when={date()}>{(d) => <> · {d()}</>}</Show>
      </span>
      <Show when={text()}>
        <span class="em-quote-text">{text()}</span>
      </Show>
      <Show when={props.quote.image}>
        {(image) => (
          <img
            src={sizedImage(image())}
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            onError={hideBroken}
            decoding="async"
          />
        )}
      </Show>
    </a>
  );
}

/** A post's photos, videos, link preview and quoted post, as X shows them. */
export function PostEmbeds(props: { post: ResultPost }) {
  const media = () => props.post.media ?? [];

  return (
    <>
      <Show when={media().length}>
        <div class="em-media" data-count={media().length}>
          <For each={media()}>
            {(item) => (
              <MediaItem media={item} single={media().length === 1} href={props.post.url} />
            )}
          </For>
        </div>
      </Show>
      {/* X shows a link preview only when there is no media to show. */}
      <Show when={!media().length && props.post.card}>{(card) => <CardEmbed card={card()} />}</Show>
      <Show when={props.post.quote}>{(quote) => <QuoteEmbed quote={quote()} />}</Show>
    </>
  );
}
