import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { AccountLibraryRow } from "../../convex/lib/contracts";
import type { Id } from "../../convex/_generated/dataModel";
import { acquisitionStatusLabel } from "../jobText";
import { describeError } from "../errors";
import { acquisitionStatusTone, formatRelative, isStalledRun } from "./format";
import { Badge } from "./format.tsx";

/**
 * The compact "what's downloading right now" strip. Built only from
 * `AccountLibraryRow.latestJob` (one field already returned by
 * `convex/library.ts rows`) — no separate job-list query — so it can only
 * ever show account-identified acquisition, never the non-account
 * live/post/etc. jobs that to-do.md P0 says must stay out of this list.
 */
export default function ActiveQueue({
  rows,
  isAuthenticated,
}: {
  rows: AccountLibraryRow[] | undefined;
  isAuthenticated: boolean;
}) {
  if (!rows)
    return (
      <section className="library-section" aria-label="Active queue">
        <h2>Active queue</h2>
        {/* `undefined` means either "query skipped because signed out" or
            "still in flight" -- they are different states and must not share
            a label. */}
        {isAuthenticated ? (
          <p className="library-loading">Loading queue…</p>
        ) : (
          <p className="library-muted">Connect to see work in progress.</p>
        )}
      </section>
    );

  const active = rows.filter(
    (r) => r.latestJob && (r.latestJob.status === "queued" || r.latestJob.status === "running"),
  );

  return (
    <section className="library-section" aria-label="Active queue">
      <h2>Active queue</h2>
      {active.length === 0 ? (
        <p className="library-muted">Nothing is downloading right now.</p>
      ) : (
        <div className="library-queue-list">
          {active.map((row) => (
            <QueueRow key={row.accountId} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function QueueRow({ row }: { row: AccountLibraryRow }) {
  const job = row.latestJob;
  const cancel = useMutation(api.jobs.cancel);
  const [error, setError] = useState("");

  // ActiveQueue only ever passes rows whose latestJob is set (see the
  // filter above); this guard just satisfies the type checker without a
  // non-null assertion — it should never actually render null in practice.
  if (!job) return null;
  const stalled = isStalledRun(job.status, job.updatedAt);

  const stop = async (jobId: Id<"jobs">) => {
    setError("");

    try {
      await cancel({ jobId });
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="library-queue-row">
      <span className="library-queue-identity">
        {row.name} <span className="library-muted">@{row.handle}</span>
      </span>
      <span className={stalled ? "stalled" : undefined}>
        {stalled
          ? `No update in over 10m — may be stalled (${acquisitionStatusLabel(job.status)})`
          : acquisitionStatusLabel(job.status)}
      </span>
      <Badge tone={acquisitionStatusTone(job.status)}>{formatRelative(job.updatedAt)}</Badge>
      <button onClick={() => stop(job.jobId)}>Stop</button>
      {error && (
        <span role="alert" className="library-row-failure">
          {error}
        </span>
      )}
    </div>
  );
}
