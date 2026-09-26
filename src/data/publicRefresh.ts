import { createSignal } from "solid-js";
import { capture } from "../posthog";
import { cooldownLabel, createCooldown } from "../library/cooldown";

/** The public page's own refresh cooldown, shared with the Connections panel. */
export const PUBLIC_REFRESH_COOLDOWN_MS = 30_000;

const [version, setVersion] = createSignal(0);

const cooldown = createCooldown("public", PUBLIC_REFRESH_COOLDOWN_MS);

/**
 * One refresh scope for the search app's hand-refreshed reads: the bootstrap
 * (`integrations.configured`), and in the operator build the Connections
 * panel and account badge. Every `useSnapshot` on that surface takes
 * `version` as its trigger, so the header button re-reads whatever is on
 * screen — and nothing that is not.
 */
export const publicRefresh = {
  version,
  cooldown,
  /** Mark that a read has begun now, which starts the cooldown. */
  began(now: number): void {
    cooldown.start(now);
  },
  /**
   * The header button. Returns what to tell the person; `null` means the
   * refresh went ahead.
   */
  request(now: number): string | null {
    const remaining = cooldown.remaining(now);

    if (remaining > 0) {
      capture("ops_dashboard_refresh_blocked", {
        scope: "public",
        tab: "search",
        remainingMs: remaining,
      });

      return `Refresh again in ${cooldownLabel(remaining)}.`;
    }

    cooldown.start(now);
    setVersion(version() + 1);
    capture("ops_dashboard_refresh", {
      scope: "public",
      tab: "search",
      queries: "integrations:configured",
      durationMs: 0,
      outcome: "started",
    });

    return null;
  },
};
