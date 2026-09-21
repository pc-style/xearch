import { useEffect, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import * as stylex from "@stylexjs/stylex";
import { Check } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { AccountBadge } from "../auth/AccountBadge";
import { handoffReady, receiverConnection, type Connection } from "../integrationStatus";
import { site } from "../styles/site.stylex";

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
  const config = useQuery(api.integrations.operator, isAuthenticated ? {} : "skip");
  // Worker liveness is judged against this clock, not inside the Convex
  // query — a query re-runs when a document changes, never because time
  // passed, so a server-decided boolean would stay true after the worker
  // went quiet. Ticking here lets the row decay on its own.
  const [now, setNow] = useState(() => Date.now());
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
      <p {...stylex.props(site.mutedCopy)}>
        Search is live once your data service returns results. The remaining connections are
        optional improvements.
      </p>
      {connections.map((c) => (
        <div {...stylex.props(site.connectionRow)} key={c.name}>
          <div {...stylex.props(site.connectionRowTop)}>
            <strong {...stylex.props(site.connectionRowName)}>{c.name}</strong>
            <p {...stylex.props(site.connectionRowText)}>{c.purpose}</p>
            <small>
              {!isAuthenticated ? (
                "Sign in to view"
              ) : config === undefined ? (
                "Checking…"
              ) : (
                <>
                  {c.ready ? <Check size={12} /> : <span {...stylex.props(site.statusDot)} />}{" "}
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
