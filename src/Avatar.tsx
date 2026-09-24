import { createSignal, Show } from "solid-js";

/** A profile picture that falls back to initials when the image fails (or
 * there is none). `fallbackClass`/`letters` let the dashboard keep its own
 * one-letter badge. */
export function Avatar(props: {
  name: string;
  url?: string;
  class?: string;
  fallbackClass?: string;
  letters?: number;
}) {
  const [failed, setFailed] = createSignal<string>();

  return (
    <Show
      when={props.url && props.url !== failed() ? props.url : undefined}
      fallback={
        <span class={props.fallbackClass ?? ["avatar", props.class]} aria-hidden="true">
          {props.name.slice(0, props.letters ?? 2).toUpperCase()}
        </span>
      }
    >
      {(url) => (
        <img
          class={props.class}
          src={url()}
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          onError={() => setFailed(url())}
        />
      )}
    </Show>
  );
}
