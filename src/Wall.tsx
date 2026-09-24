import { createSignal, For, Show } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../convex/_generated/api";
import { Avatar } from "./Avatar";
import { Icon } from "./icons";
import { compact } from "./format";
import { ringAvatarUrl } from "./avatarUrl";

export type Account = FunctionReturnType<typeof api.search.accounts>[number];

export type WallPost = FunctionReturnType<typeof api.wall.posts>[number];

/**
 * The home page's right-hand wall: two endless columns — each imported
 * account's most-liked posts (convex/wall.ts) and the accounts' faces —
 * drifting in opposite directions. Every item searches that account.
 *
 * Each column is rendered twice so the CSS animation can loop seamlessly
 * (translate by half, restart); the second copy is hidden from assistive
 * tech and the tab order so a keyboard or screen-reader user meets each
 * item once.
 */
export function Wall(props: {
  accounts: Account[];
  posts: WallPost[];
  loading: boolean;
  onAccount: (handle: string) => void;
}) {
  const [hovered, setHovered] = createSignal<string | null>(null);

  const avatarFor = (handle: string) =>
    props.accounts.find((a) => a.handle.toLowerCase() === handle.toLowerCase())?.avatar;

  const caption = () => {
    const handle = hovered();

    if (handle) return { handle };

    if (props.loading) return { text: "Loading the search library…" };

    if (!props.accounts.length) return { text: "No accounts have been imported yet." };

    const n = props.accounts.length;

    return { text: `${n} imported ${n === 1 ? "account" : "accounts"} · hover to pause` };
  };

  const Card = (p: { post: WallPost; copy: boolean }) => (
    <button
      type="button"
      class="card"
      aria-hidden={p.copy ? "true" : undefined}
      tabindex={p.copy ? -1 : undefined}
      aria-label={`Search @${p.post.author}`}
      onPointerEnter={() => setHovered(p.post.author)}
      onFocus={() => setHovered(p.post.author)}
      onClick={() => props.onAccount(p.post.author)}
    >
      <p class="ct">{p.post.text}</p>
      <span class="cm">
        <Avatar name={p.post.author} url={p.post.avatar ?? avatarFor(p.post.author)} />
        <b>@{p.post.author}</b>
        <span class="n">
          <Show when={p.post.reposts !== undefined}>
            <span>
              <Icon name="repeat-2" size={13} />
              {compact(p.post.reposts!)}
            </span>
          </Show>
          <Show when={p.post.likes !== undefined}>
            <span>
              <Icon name="heart" size={13} />
              {compact(p.post.likes!)}
            </span>
          </Show>
        </span>
      </span>
    </button>
  );

  const Face = (p: { account: Account; copy: boolean }) => (
    <button
      type="button"
      class="face"
      aria-hidden={p.copy ? "true" : undefined}
      tabindex={p.copy ? -1 : undefined}
      title={`Search @${p.account.handle}`}
      aria-label={`Search @${p.account.handle}`}
      onPointerEnter={() => setHovered(p.account.handle)}
      onFocus={() => setHovered(p.account.handle)}
      onClick={() => props.onAccount(p.account.handle)}
    >
      <Avatar name={p.account.handle} url={ringAvatarUrl(p.account.avatar)} />
    </button>
  );

  return (
    <div class="wall-wrap">
      <div
        class={["flows", { "faces-only": !props.posts.length }]}
        onPointerLeave={() => setHovered(null)}
      >
        <Show when={props.posts.length}>
          <div class="flow posts" role="group" aria-label="Popular posts from imported accounts">
            <div class="track">
              <For each={[false, true]}>
                {(copy) => (
                  <For each={props.posts} keyed={(p) => p._id}>
                    {(post) => <Card post={post()} copy={copy} />}
                  </For>
                )}
              </For>
            </div>
          </div>
        </Show>
        <div class="flow faces" role="group" aria-label="Imported accounts">
          <div class="track">
            <For each={[false, true]}>
              {(copy) => (
                <For each={props.accounts} keyed={(a) => a._id}>
                  {(account) => <Face account={account()} copy={copy} />}
                </For>
              )}
            </For>
          </div>
        </div>
      </div>
      <p class="wall-cap" aria-live="polite">
        <Show when={caption().handle} fallback={caption().text}>
          Search <b>@{caption().handle}</b>
        </Show>
      </p>
    </div>
  );
}
