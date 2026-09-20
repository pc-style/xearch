import type { AccountLibraryRow } from "../../convex/lib/contracts";
import { acquisitionStatusLabel } from "../jobText";
import { Badge, acquisitionStatusTone, formatRelative } from "./format";

const RECENT_LIMIT = 8;

type RowWithJob = AccountLibraryRow & {
  latestJob: NonNullable<AccountLibraryRow["latestJob"]>;
};

/**
 * The "secondary run history" block from to-do.md P0's compact-layout
 * bullet ("overview, account library, active queue, and secondary run
 * history"). Distinct from the other two run-related views already in this
 * unit:
 *   - <ActiveQueue> only shows jobs currently queued/running.
 *   - Each <AccountRow>'s own expandable history is the full, per-account
 *     record (every run, receipts, raw diagnostics) — the primary place for
 *     detail.
 * This is the compact, library-wide "what happened recently" strip: the
 * last few runs across every account, whatever their outcome, so a person
 * can see recent activity without opening each row. It reads only
 * `AccountLibraryRow.latestJob` — the same field <ActiveQueue> already
 * reads — so it needs no new query and cannot show anything beyond what the
 * account library itself already received.
 */
export default function RecentActivity({ rows }: { rows: AccountLibraryRow[] | undefined }) {
  if (!rows)
    return (
      <section className="library-section" aria-label="Recent run history">
        <h2>Recent run history</h2>
        <p className="library-loading">Loading recent activity…</p>
      </section>
    );

  const recent: RowWithJob[] = rows
    .filter((r): r is RowWithJob => r.latestJob !== undefined)
    .sort((a, b) => b.latestJob.updatedAt - a.latestJob.updatedAt)
    .slice(0, RECENT_LIMIT);

  return (
    <section className="library-section" aria-label="Recent run history">
      <div className="library-section-head">
        <h2>Recent run history</h2>
        <p className="library-muted">
          The most recent runs across your library. Expand an account above for its full history
          and receipts.
        </p>
      </div>
      {recent.length === 0 ? (
        <p className="library-muted">No runs recorded yet.</p>
      ) : (
        // Reuses <ActiveQueue>'s row styling (.library-queue-*) on purpose:
        // same visual shape (identity + status badge + timestamp), just a
        // different, broader set of rows — not worth a parallel CSS block.
        <div className="library-queue-list">
          {recent.map((row) => (
            <div className="library-queue-row" key={row.accountId}>
              <span className="library-queue-identity">
                {row.name} <span className="library-muted">@{row.handle}</span>
              </span>
              <Badge tone={acquisitionStatusTone(row.latestJob.status)}>
                {acquisitionStatusLabel(row.latestJob.status)}
              </Badge>
              <span className="library-muted">{formatRelative(row.latestJob.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
