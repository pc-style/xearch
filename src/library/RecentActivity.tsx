import * as stylex from "@stylexjs/stylex";
import type { AccountLibraryRow } from "../../convex/lib/contracts";
import { acquisitionStatusLabel } from "../jobText";
import { acquisitionStatusTone, formatRelative } from "./format";
import { Badge } from "./format.tsx";
import { ops } from "../styles/ops.stylex";

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
export default function RecentActivity({
  rows,
  isAuthenticated,
}: {
  rows: AccountLibraryRow[] | undefined;
  isAuthenticated: boolean;
}) {
  if (!rows)
    return (
      <section {...stylex.props(ops.section)} aria-label="Recent run history">
        <h2 {...stylex.props(ops.sectionTitle)}>Recent run history</h2>
        {/* Skipped-because-signed-out and still-loading both arrive as
            `undefined`; they are different states and get different words. */}
        {isAuthenticated ? (
          <p {...stylex.props(ops.loading)}>Loading recent activity…</p>
        ) : (
          <p {...stylex.props(ops.libraryMuted)}>Connect to see your recent runs.</p>
        )}
      </section>
    );

  const recent: RowWithJob[] = rows
    .filter((r): r is RowWithJob => r.latestJob !== undefined)
    .sort((a, b) => b.latestJob.updatedAt - a.latestJob.updatedAt)
    .slice(0, RECENT_LIMIT);

  return (
    <section {...stylex.props(ops.section)} aria-label="Recent run history">
      <div {...stylex.props(ops.sectionHead)}>
        <h2 {...stylex.props(ops.sectionTitle)}>Recent run history</h2>
        <p {...stylex.props(ops.libraryMuted)}>
          The most recent runs across your library. Expand an account above for its full history and
          receipts.
        </p>
      </div>
      {recent.length === 0 ? (
        <p {...stylex.props(ops.libraryMuted)}>No runs recorded yet.</p>
      ) : (
        // Reuses <ActiveQueue>'s row styling on purpose:
        // same visual shape (identity + status badge + timestamp), just a
        // different, broader set of rows — not worth a parallel style block.
        <div {...stylex.props(ops.queueList)}>
          {recent.map((row) => (
            <div {...stylex.props(ops.queueRow)} key={row.accountId}>
              <span {...stylex.props(ops.queueIdentity)}>
                {row.name} <span {...stylex.props(ops.libraryMuted)}>@{row.handle}</span>
              </span>
              <Badge tone={acquisitionStatusTone(row.latestJob.status)}>
                {acquisitionStatusLabel(row.latestJob.status)}
              </Badge>
              <span {...stylex.props(ops.libraryMuted)}>
                {formatRelative(row.latestJob.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
