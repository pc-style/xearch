import { createSignal, flush, For, Match, Show, Switch } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { useAction } from "../data/convex";
import { describeError } from "../errors";
import { Avatar } from "../Avatar";
import { ringAvatarUrl } from "../avatarUrl";
import { compact, postDate } from "../format";
import { OPS_PATH, pushHref } from "../locationStore";
import { operatorArgs } from "../operatorToken";
import type { JevLabProps } from "../operatorSurface";
import { jumpFrom } from "./jump";
import "./jev.css";

type Candidates = FunctionReturnType<typeof api.jev.candidates>;

type Ranking = FunctionReturnType<typeof api.jev.rank>;

type Post = Candidates["rows"][number];

type Method = "score" | "pick";

const METHODS: { id: Method; label: string; hint: string }[] = [
  { id: "score", label: "score", hint: "one yes/no per post" },
  { id: "pick", label: "pick", hint: "one choice over all posts" },
];

const EXCERPT_CHARS = 280;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function Card(props: { post: Post; rank: number; value?: number; moved?: number }) {
  const date = () => postDate(props.post.createdAt);

  return (
    <li class="jev-card" data-tweet={props.post.tweetId}>
      <span class="jev-rank">{props.rank}</span>
      <Avatar
        name={props.post.author}
        url={ringAvatarUrl(props.post.avatar)}
        class="jev-av"
        fallbackClass="jev-av jev-av-letters"
      />
      <div class="jev-body">
        <div class="jev-meta">
          <a href={props.post.url} target="_blank" rel="noreferrer">
            @{props.post.author}
          </a>
          <Show when={date()}>{(when) => <span>{when()}</span>}</Show>
          <Show when={props.post.likes}>{(likes) => <span>{compact(likes())} likes</span>}</Show>
        </div>
        <p>{excerpt(props.post.text)}</p>
      </div>
      <div class="jev-side">
        <Show when={props.value !== undefined}>
          <span class="jev-value">{percent(props.value ?? 0)}</span>
        </Show>
        <Show when={props.moved}>
          {(moved) => (
            <span class={moved() > 0 ? "jev-move up" : "jev-move down"}>
              {moved() > 0 ? `↑${moved()}` : `↓${-moved()}`}
            </span>
          )}
        </Show>
      </div>
    </li>
  );
}

/**
 * /pc-jev: Adam's Jev search, operator site only. Search the normal way,
 * then "jev it": Jev guesses what the search is for and reranks the same
 * candidates, which jump across into the Jev column.
 */
export default function JevLab(props: JevLabProps) {
  const fetchCandidates = useAction(api.jev.candidates);
  const rankWithJev = useAction(api.jev.rank);

  const [raw, setRaw] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [found, setFound] = createSignal<Candidates | null>(null);
  const [ranking, setRanking] = createSignal<Ranking | null>(null);
  const [method, setMethod] = createSignal<Method>("score");
  const [busy, setBusy] = createSignal<"search" | "jev" | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  let literalList: HTMLOListElement | undefined;
  let jevList: HTMLOListElement | undefined;

  const rows = () => found()?.rows ?? [];

  const jevOrder = () => {
    const current = ranking();

    if (!current) return [];
    const values = current[method()];

    return rows()
      .map((post, index) => ({ post, index, value: values[index] ?? 0 }))
      .sort((a, b) => b.value - a.value || a.index - b.index);
  };

  const jump = () => {
    flush();

    if (literalList && jevList) jumpFrom(literalList, jevList);
  };

  const search = async (event: SubmitEvent) => {
    event.preventDefault();
    const text = raw().trim();

    if (!text || busy()) return;
    setBusy("search");
    setError(null);

    try {
      await props.ensureSession();
      const next = await fetchCandidates({ raw: text, ...operatorArgs() });

      setRanking(null);
      setQuery(text);
      setFound(next);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const jevIt = async () => {
    if (!rows().length || busy()) return;
    setBusy("jev");
    setError(null);

    try {
      const next = await rankWithJev({
        raw: query(),
        posts: rows().map(({ tweetId, author, text, likes, createdAt, links }) => ({
          tweetId,
          author,
          text,
          likes,
          createdAt,
          links,
        })),
        ...operatorArgs(),
      });

      setRanking(next);
      jump();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const chooseMethod = (next: Method) => {
    if (next === method()) return;
    setMethod(next);
    jump();
  };

  return (
    <main class="jev">
      <header class="jev-top">
        <h1>
          jev search <span class="jev-chip">dev</span>
        </h1>
        <button type="button" class="text-button" onClick={() => pushHref(OPS_PATH)}>
          Dashboard
        </button>
      </header>

      <form class="jev-form" onSubmit={search}>
        <input
          type="search"
          value={raw()}
          onInput={(event) => setRaw(event.currentTarget.value)}
          placeholder="Search posts, then let Jev rerank them"
          aria-label="Search"
          maxlength={300}
        />
        <button type="submit" disabled={!raw().trim() || busy() !== null}>
          {busy() === "search" ? "Searching…" : "Search"}
        </button>
        <button
          type="button"
          class="jev-it"
          disabled={!rows().length || busy() !== null}
          onClick={jevIt}
        >
          {busy() === "jev" ? "Jev is thinking…" : "jev it"}
        </button>
      </form>

      <Show when={error()}>
        {(message) => (
          <p class="jev-error" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <Show when={found()}>
        {(current) => (
          <Show when={current().warnings.length}>
            <p class="jev-note">{current().warnings.join(" ")}</p>
          </Show>
        )}
      </Show>

      <div class="jev-cols">
        <section class="jev-col" aria-label="Search service order">
          <div class="jev-col-head">
            <h2>literal</h2>
            <Show when={found()}>
              {(current) => (
                <span>
                  {current().rows.length}
                  {current().total !== undefined
                    ? ` of ${compact(current().total ?? 0)} matches`
                    : " posts"}
                </span>
              )}
            </Show>
          </div>
          <Switch>
            <Match when={busy() === "search"}>
              <p class="jev-empty">Searching…</p>
            </Match>
            <Match when={!found()}>
              <p class="jev-empty">Search for something, then press “jev it”.</p>
            </Match>
            <Match when={!rows().length}>
              <p class="jev-empty">No posts match “{query()}”.</p>
            </Match>
            <Match when={true}>
              <ol class="jev-list" ref={(element) => (literalList = element)}>
                <For each={rows()} keyed={(post) => post.tweetId}>
                  {(post, index) => <Card post={post()} rank={index() + 1} />}
                </For>
              </ol>
            </Match>
          </Switch>
        </section>

        <section class="jev-col" aria-label="Jev order">
          <div class="jev-col-head">
            <h2>jev</h2>
            <div class="jev-methods" role="group" aria-label="Ranking method">
              <For each={METHODS}>
                {(entry) => (
                  <button
                    type="button"
                    title={entry.hint}
                    aria-pressed={method() === entry.id ? "true" : "false"}
                    onClick={() => chooseMethod(entry.id)}
                  >
                    {entry.label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <Show when={ranking()}>
            {(current) => (
              <p class="jev-stats">
                wants {current().intent.label} ({percent(current().intent.confidence)} sure) ·{" "}
                {current().ms.total} ms · {compact(current().inputTokens)} tokens
              </p>
            )}
          </Show>
          <Switch>
            <Match when={busy() === "jev"}>
              <p class="jev-empty jev-thinking">Jev is reading {rows().length} posts…</p>
            </Match>
            <Match when={!ranking()}>
              <p class="jev-empty">Jev's order lands here.</p>
            </Match>
            <Match when={true}>
              <ol class="jev-list" ref={(element) => (jevList = element)}>
                <For each={jevOrder()} keyed={(entry) => entry.post.tweetId}>
                  {(entry, slot) => (
                    <Card
                      post={entry().post}
                      rank={slot() + 1}
                      value={entry().value}
                      moved={entry().index - slot()}
                    />
                  )}
                </For>
              </ol>
            </Match>
          </Switch>
        </section>
      </div>
    </main>
  );
}
