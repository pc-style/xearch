import type { JSX } from "@solidjs/web";
import type { Tone } from "./format";

export function Badge(props: { tone: Tone; children: JSX.Element }) {
  return <span class={["library-badge", `tone-${props.tone}`]}>{props.children}</span>;
}
