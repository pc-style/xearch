import { useConvexAuth, useConvexConnectionState, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { summaryQuery, healthQuery } from "./summaryApi";
import { limitsAllQuery } from "./limitsApi";
import OverviewStats from "./OverviewStats";
import ActiveQueue from "./ActiveQueue";
import AccountLibrary from "./AccountLibrary";
import RecentActivity from "./RecentActivity";
import "../dashboard.css";
import { useDashboardClock } from "./clock";

// convex/summary.ts's `summary`/`health` queries take `now` as a REQUIRED
// arg (a query must never read the wall clock itself) and expect the caller
// to refresh it so `observedAt`/`stale` actually advance — see that file's
// own comment. An interval, not a one-time `Date.now()` at mount, is what
// makes that true.
/**
 * The new import/library dashboard (to-do.md P0 "Replace the job wall with
 * an account library"). A single mountable entry component, in the exact
 * section order to-do.md's compact-layout bullet names: overview, account
 * library (searchable/filterable, with expandable per-account history),
 * active queue, and a secondary run-history strip. Reads only
 * `convex/library.ts` and `convex/summary.ts` (the latter via
 * `./summaryApi`, since `convex/_generated/api.d.ts` does not list that
 * module yet — see that file's comment), typed throughout via
 * `convex/lib/contracts.ts`.
 *
 * Does not render an import-start form or the non-account jobs list — those
 * stay wherever the integrator's own Dashboard/App code already renders
 * them. `ensureSession` mirrors Dashboard.tsx's existing prop so the
 * integrator can wire it the same way.
 */
export default function Library({ ensureSession }: { ensureSession: () => Promise<unknown> }) {
  const { isAuthenticated } = useConvexAuth();
  const connected = useConvexConnectionState().isWebSocketConnected;
  const now = useDashboardClock();
  const summary = useQuery(summaryQuery, isAuthenticated ? { now } : "skip");
  const health = useQuery(healthQuery, isAuthenticated ? { now } : "skip");
  const limits = useQuery(limitsAllQuery, isAuthenticated ? {} : "skip");
  // Unfiltered rows for the active-queue strip, independent of whatever
  // search/status filter is set inside <AccountLibrary>below. Same
  // convex/library.ts `rows` query, just a second live subscription with
  // different args — Convex serves each set of args as its own cached query.
  const allLibrary = useQuery(api.library.rows, isAuthenticated ? {} : "skip");
  const allRows = allLibrary?.rows;

  return (
    <div className="library">
      {!connected && (
        <p className="library-offline-banner" role="status">
          Reconnecting to Convex — the figures below reflect the last data this page received, not
          necessarily the current state.
        </p>
      )}
      <OverviewStats
        summary={summary}
        health={health}
        limits={limits}
        connected={connected}
        isAuthenticated={isAuthenticated}
      />
      <AccountLibrary
        isAuthenticated={isAuthenticated}
        connected={connected}
        onConnect={() => {
          void ensureSession();
        }}
      />
      <ActiveQueue rows={allRows} isAuthenticated={isAuthenticated} />
      <RecentActivity rows={allRows} isAuthenticated={isAuthenticated} />
    </div>
  );
}
