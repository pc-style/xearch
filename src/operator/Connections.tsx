import { useEffect, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Check } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { AccountBadge } from "../auth/AccountBadge";
import { handoffReady, receiverConnection, type Connection } from "../integrationStatus";

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
  const { isAuthenticated } = useConvexAuth();
  // Worker liveness is judged against this clock: convex/integrations.ts's
  // `operator` takes `now` as a required arg (never reads the wall clock
  // itself — a query re-runs when a document changes, never because time
  // passed) and `handoffReady` below re-derives `handoffState.lastSeenAt`
  // against this same ticking clock, so the reading keeps decaying between
  // query re-runs instead of freezing at the last write.
  const [now, setNow] = useState(() => Date.now());
  const config = useQuery(api.integrations.operator, isAuthenticated ? { now } : "skip");
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);

    return () => clearInterval(id);
  }, []);

  const connections: Connection[] = [
    {
      name: "Search service",
      ready: config?.search,
      env: "SEARCH_API_URL, SEARCH_SERVICE_TOKEN",
      purpose: "Finds posts in your library",
    },
    receiverConnection(config?.collectorMode, handoffReady(config?.handoffState, now)),
    {
      name: "x.md",
      ready: config?.xmd,
      env: "X_MD_API_KEY",
      purpose: "Account histories, live search, conversations",
    },
    {
      name: "Firecrawl",
      ready: config?.firecrawl,
      env: "FIRECRAWL_API_KEY",
      purpose: "Reads pages linked in posts",
    },
    {
      name: "OpenAI",
      ready: config?.openai,
      env: "OPENAI_API_KEY",
      purpose: "Turns a question into a clearer search",
    },
    {
      name: "AgentMail",
      ready: config?.email,
      env: "AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID",
      purpose: "Emails search results",
    },
  ];

  return (
    <>
      <p className="muted-copy">
        Search is live once your data service returns results. The remaining connections are
        optional improvements.
      </p>
      {connections.map((c) => (
        <div className="connection-row" key={c.name}>
          <div>
            <strong>{c.name}</strong>
            <p>{c.purpose}</p>
            <small>
              {!isAuthenticated ? (
                "Sign in to view"
              ) : config === undefined ? (
                "Checking…"
              ) : (
                <>
                  {c.ready ? <Check size={12} /> : <span className="status-dot" />}{" "}
                  {c.ready
                    ? c.proves === "live"
                      ? "Connected"
                      : "Configured"
                    : c.proves === "live"
                      ? "Not connected"
                      : "Not configured"}
                  {c.env ? ` · ${c.env}` : ""}
                </>
              )}
            </small>
            {c.note && <small>{c.note}</small>}
          </div>
        </div>
      ))}
      {config?.collectorMode === "outbound" && <AccountBadge />}
    </>
  );
}

export default ConnectionsPanel;
