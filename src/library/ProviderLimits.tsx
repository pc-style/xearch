import { For, Show } from "solid-js";
import type { ProviderLimit } from "../../convex/limits";
import { Badge } from "./format.tsx";

const PROVIDER_DISPLAY_NAME: Record<ProviderLimit["provider"], string> = {
  xmd: "x.md",
  receiver: "Raw-capture receiver",
  search: "Search backend",
};

type Throttled = Extract<ProviderLimit, { kind: "throttled" }>;

/**
 * Provider-reported throttling (to-do.md P0 "Provider limits"). Built only
 * from `convex/limits.ts` (`ProviderLimit[]`) — never `jobs.error`, which can
 * hold a stale historical message left on an old job row, indistinguishable
 * from a live one by content alone.
 *
 * B2 ("hide provider limits unless something is actually throttled"): this
 * renders nothing at all — not a heading, not a "No throttling reported"
 * badge, not a "loading…"/"connect to view" placeholder — until at least one
 * provider has actually reported being throttled. A permanent row of green
 * badges is not a fact worth a person's attention; a real throttle is.
 */
export default function ProviderLimits(props: {
  limits: ProviderLimit[] | undefined;
  isAuthenticated: boolean;
}) {
  const throttled = () => props.limits?.filter((l): l is Throttled => l.kind === "throttled") ?? [];

  return (
    <Show when={throttled().length}>
      <div>
        <h3 class="library-subhead">Provider limits</h3>
        <div class="library-health-row" role="status">
          <For each={throttled()}>
            {(limit) => (
              <Badge tone="warning">
                {PROVIDER_DISPLAY_NAME[limit.provider]}: Throttled on {limit.operation}
              </Badge>
            )}
          </For>
        </div>
        <div>
          <For each={throttled()}>
            {(limit) => (
              <p class="library-muted">
                {PROVIDER_DISPLAY_NAME[limit.provider]}: {limit.reason}
                {limit.remaining.kind === "known"
                  ? ` — ${limit.remaining.value.toLocaleString()} remaining`
                  : " — remaining allowance unknown"}
                {limit.resetAt !== undefined
                  ? `, resets ${new Date(limit.resetAt).toLocaleTimeString()}`
                  : ""}
                {limit.nextRetryAt !== undefined
                  ? `. Next retry around ${new Date(limit.nextRetryAt).toLocaleTimeString()}.`
                  : ""}
              </p>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
