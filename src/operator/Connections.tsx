import { For, Show } from "solid-js";
import { useConvex, useQuery } from "../data/convex";
import { api } from "../../convex/_generated/api";
import { AccountBadge } from "../auth/AccountBadge";
import { handoffReady, receiverConnection, type Connection } from "../integrationStatus";
import { useLiveNow } from "../library/clock";
import { Icon } from "../icons";

/**
 * The Connections panel: which services this deployment has been given, and
 * the environment variables that supply them.
 *
 * This is operator surface, not product surface — a visitor searching for
 * posts has no use for the name `AGENTMAIL_API_KEY` — so it lives here,
 * behind `OPERATOR_BUILD`'s dynamic import, and reads
 * `integrations.operator` rather than the public bootstrap query. Keeping it
 * in its own module is what keeps those variable names out of the public
 * bundle; a plain `{OPERATOR_BUILD && ...}` guard inside App.tsx would still
 * have shipped every one of these strings to convex.site.
 */
export function ConnectionsPanel() {
  // Skipped until a session exists: `integrations.operator` requires one,
  // and asking early throws into the app's error boundary.
  const { isAuthenticated } = useConvex();
  // Worker liveness is judged against this clock: convex/integrations.ts's
  // `operator` takes `now` as a required arg (never reads the wall clock
  // itself — a query re-runs when a document changes, never because time
  // passed) and `handoffReady` below re-derives `handoffState.lastSeenAt`
  // against this same ticking clock, so the reading keeps decaying between
  // query re-runs instead of freezing at the last write. `useLiveNow`, not
  // the bucketed dashboard clock — see its comment in src/library/clock.ts
  // for why a rounded `now` cannot feed this 45s liveness window safely.
  const now = useLiveNow();

  const config = useQuery(api.integrations.operator, () =>
    isAuthenticated() ? { now: now() } : "skip",
  );

  const connections = (): Connection[] => [
    {
      name: "Search service",
      ready: config()?.search,
      purpose: "Finds posts in your library",
    },
    receiverConnection(config()?.collectorMode, handoffReady(config()?.handoffState, now())),
    {
      name: "x.md",
      ready: config()?.xmd,
      purpose: "Account histories, live search, conversations",
    },
    {
      name: "Firecrawl",
      ready: config()?.firecrawl,
      purpose: "Reads pages linked in posts",
    },
    {
      name: "OpenAI",
      ready: config()?.openai,
      purpose: "Turns a question into a clearer search",
    },
    {
      name: "AgentMail",
      ready: config()?.email,
      purpose: "Emails search results",
    },
  ];

  const status = (c: Connection) =>
    c.ready
      ? c.proves === "live"
        ? "Connected"
        : "Configured"
      : c.proves === "live"
        ? "Not connected"
        : "Not configured";

  return (
    <>
      <For each={connections()}>
        {(c) => (
          <div class="connection-row">
            <div>
              <strong>{c.name}</strong>
              <p>{c.purpose}</p>
              <small>
                <Show when={isAuthenticated()} fallback={"Sign in to view"}>
                  <Show when={config()} fallback={"Checking…"}>
                    <Show when={c.ready} fallback={<span class="status-dot" />}>
                      <Icon name="check" size={12} />
                    </Show>{" "}
                    {status(c)}
                  </Show>
                </Show>
              </small>
              <Show when={c.note}>
                <small>{c.note}</small>
              </Show>
            </div>
          </div>
        )}
      </For>
      <Show when={config()?.collectorMode === "outbound"}>
        <AccountBadge />
      </Show>
    </>
  );
}

export default ConnectionsPanel;
