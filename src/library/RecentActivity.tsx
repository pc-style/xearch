import { For, Show } from "solid-js";
import type { AccountLibraryRow } from "../../convex/lib/contracts";
import { DOWNLOAD_COMPLETE_CAVEAT, acquisitionStatusLabel } from "../jobText";
import { acquisitionStatusTone, countWithUnit, formatRelative } from "./format";
import { Badge } from "./format.tsx";

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
export default function RecentActivity(props: {
  rows: AccountLibraryRow[] | undefined;
  isAuthenticated: boolean;
}) {
  const recent = () =>
    (props.rows ?? [])
      .filter((r): r is RowWithJob => r.latestJob !== undefined)
      .sort((a, b) => b.latestJob.updatedAt - a.latestJob.updatedAt)
      .slice(0, RECENT_LIMIT);

  return (
    <Show
      when={props.rows}
      fallback={
        <section class="library-section" aria-label="Recent run history">
          <h2>Recent run history</h2>
          {/* Skipped-because-signed-out and still-loading both arrive as
              `undefined`; they are different states and get different words. */}
          <Show
            when={props.isAuthenticated}
            fallback={<p class="library-muted">Connect to see your recent runs.</p>}
          >
            <p class="library-loading">Loading recent activity…</p>
          </Show>
        </section>
      }
    >
      <section class="library-section" aria-label="Recent run history">
        <div class="library-section-head">
          <h2>Recent run history</h2>
          <p class="library-muted">
            The most recent runs across your library. Expand an account in the library below for its
            full history and receipts. {DOWNLOAD_COMPLETE_CAVEAT}
          </p>
        </div>
        <Show when={recent().length} fallback={<p class="library-muted">No runs recorded yet.</p>}>
          {/* Reuses <ActiveQueue>'s row styling on purpose: same shape, a
              broader set of rows. */}
          <div class="library-queue-list">
            <For each={recent()} keyed={(row) => row.accountId}>
              {(row) => (
                <div class="library-queue-row">
                  <span class="library-queue-identity">
                    {row().name} <span class="library-muted">@{row().handle}</span>
                  </span>
                  <Badge tone={acquisitionStatusTone(row().latestJob.status)}>
                    {acquisitionStatusLabel(row().latestJob.status)}
                  </Badge>
                  {/* /tmp/issues.md item 2: a bare "Download complete" reads
                      as a complete archive; what is known is how many of
                      this account's posts are confirmed searchable. */}
                  <span class="library-muted">{countWithUnit(row().searchablePostCount)}</span>
                  <span class="library-muted">{formatRelative(row().latestJob.updatedAt)}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}
