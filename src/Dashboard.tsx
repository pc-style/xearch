import { useState } from "react";
import { useConvexAuth, useConvexConnectionState, useMutation, useQuery } from "convex/react";
import * as stylex from "@stylexjs/stylex";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { ops } from "./styles/ops.stylex";
import { indexingUnavailableMessage } from "./integrationStatus";
import { describeError, useTask } from "./errors";
import { jobLabel, jobSummary, jobWarnings } from "./jobText";
import Library from "./library/Library";

function Job({ job }: { job: Doc<"jobs"> }) {
  const [expanded, setExpanded] = useState(false),
    [error, setError] = useState("");
  const receipts = useQuery(api.jobs.receipts, expanded ? { jobId: job._id } : "skip");
  const cancel = useMutation(api.jobs.cancel),
    retry = useMutation(api.jobs.retry),
    dismiss = useMutation(api.jobs.dismiss),
    restore = useMutation(api.jobs.restore),
    start = useMutation(api.jobs.start);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    }
  };
  const active = job.status === "queued" || job.status === "running";
  const dismissed = job.dismissedAt !== undefined;
  return (
    <article {...stylex.props(ops.job, dismissed && ops.jobDismissed)}>
      <div {...stylex.props(ops.jobHeading)}>
        <h3 {...stylex.props(ops.jobTitle)}>{job.input}</h3>
        <span
          {...stylex.props(
            ops.jobStatus,
            (job.status === "running" || job.status === "queued") && ops.jobStatusRunning,
            job.status === "complete" && ops.jobStatusComplete,
            (job.status === "failed" || job.status === "partial") && ops.jobStatusFailed,
          )}
        >
          {jobLabel(job)}
        </span>
      </div>
      <p {...stylex.props(ops.jobText)}>{jobSummary(job)}</p>
      <p {...stylex.props(ops.jobText, ops.jobPhase)} role="status">
        {job.status === "complete"
          ? job.nextUntil
            ? "More history remains. Continue to download the rest automatically."
            : job.floorReached
              ? "x.md reached the oldest history it can retrieve. Older posts may still exist on X."
              : // This kind of job (live search, single post, profile, follower
                // lookup, etc.) never creates a searchable account entry — that
                // pipeline is covered per-account in the account library above,
                // which is the only place search-publication state is reported.
                "Saved. This isn't an account import, so it doesn't appear in your account library."
          : job.status === "queued" || job.status === "running"
            ? (job.phase ?? "Waiting to start")
            : job.status === "cancelled"
              ? (job.phase ?? "Stopped by request.")
              : // "failed" / "partial": never the leftover in-progress phase
                // (e.g. "Saving raw capture") here — see jobText.ts
                // stoppedRunSummary, which jobSummary above already uses for
                // the retained-progress line; the actual failure reason is
                // in job.error below. to-do.md P0 "Do not leave failed jobs
                // showing only 'Saving raw capture.'"
                "This run did not finish."}
      </p>
      <small {...stylex.props(ops.muted)}>
        Updated {new Date(job.updatedAt).toLocaleString()}
        {job.oldest ? ` | Oldest post received: ${new Date(job.oldest).toLocaleDateString()}` : ""}
      </small>
      {job.error && <p {...stylex.props(ops.jobText, ops.error)}>{job.error}</p>}
      {jobWarnings(job).map((w) => (
        <p {...stylex.props(ops.jobText, ops.warning)} key={w}>
          {w}
        </p>
      ))}
      <div {...stylex.props(ops.actions)}>
        {active && (
          <button
            {...stylex.props(ops.button)}
            onClick={() => act(() => cancel({ jobId: job._id }))}
          >
            Stop job
          </button>
        )}
        {["failed", "partial", "cancelled"].includes(job.status) && (
          <button
            {...stylex.props(ops.button)}
            onClick={() => act(() => retry({ jobId: job._id }))}
          >
            Retry download
          </button>
        )}
        {job.status === "complete" && (job.nextUntil || job.nextCursor) && (
          <button
            {...stylex.props(ops.button)}
            onClick={() =>
              act(() =>
                start({
                  kind: job.kind,
                  input: job.input,
                  previous: job._id,
                  refresh: job.refresh,
                }),
              )
            }
          >
            {job.kind === "bulk" ? "Continue remaining history" : "Download next page"}
          </button>
        )}
        {/* Clearing a finished run only hides it: the run and the receipts
            proving its captures were stored are kept, and "Bring back" puts
            it straight back in the list. Never offered while the run is
            still active — stop it first, or it would keep spending provider
            allowance with no row to stop it from. */}
        {!active &&
          (dismissed ? (
            <button
              {...stylex.props(ops.button)}
              onClick={() => act(() => restore({ jobId: job._id }))}
            >
              Bring back
            </button>
          ) : (
            <button
              {...stylex.props(ops.button)}
              onClick={() => act(() => dismiss({ jobId: job._id }))}
            >
              Clear from list
            </button>
          ))}
        <button
          {...stylex.props(ops.button)}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide technical details" : "Technical details"}
        </button>
      </div>
      {error && (
        <p role="alert" {...stylex.props(ops.jobText, ops.error)}>
          {error}
        </p>
      )}
      {expanded && (
        <div {...stylex.props(ops.receipts)}>
          {receipts === undefined
            ? "Loading receipts…"
            : receipts.length === 0
              ? "No durable acknowledgments yet."
              : receipts.map((r) => (
                  <div key={r._id} {...stylex.props(ops.receipt)}>
                    <strong>{r.records} saved response files</strong>
                    <code {...stylex.props(ops.receiptCode)}>{r.receiptId}</code>
                  </div>
                ))}
        </div>
      )}
    </article>
  );
}

export default function Dashboard({
  ensureSession,
  close,
}: {
  ensureSession: () => Promise<unknown>;
  close: () => void;
}) {
  const { isAuthenticated } = useConvexAuth();
  const connected = useConvexConnectionState().isWebSocketConnected;
  // `integrations.operator` requires a session, so asking for it before one
  // exists throws into the app's error boundary — which only offers a
  // reload. The dashboard is reachable directly by URL, so that is a normal
  // first load, not an edge case.
  const config = useQuery(api.integrations.operator, isAuthenticated ? {} : "skip");
  const [showDismissed, setShowDismissed] = useState(false);
  // Ask the server for exactly the kinds this feed shows. Filtering "bulk"
  // out here, after the server had already limited the page, could hide
  // older non-account runs behind 20 newer account imports.
  const jobs = useQuery(
    api.jobs.list,
    isAuthenticated ? { includeDismissed: showDismissed, scope: "other" } : "skip",
  );
  // Account-history ("bulk") jobs are represented per-account in <Library>
  // above (convex/library.ts groups exactly this kind); this feed exists
  // only for the non-account job kinds to-do.md P0 says must stay out of
  // the indexed-people list (live search, single post, profile, followers,
  // following, archive). The split is applied server-side via `scope`.

  const start = useMutation(api.jobs.start);
  const [kind, setKind] = useState<Doc<"jobs">["kind"]>("bulk"),
    [input, setInput] = useState(""),
    [since, setSince] = useState(""),
    [refresh, setRefresh] = useState(false);
  const { busy, message, setMessage, run } = useTask();
  return (
    <main {...stylex.props(ops.room)}>
      <header {...stylex.props(ops.header)}>
        <div>
          <button {...stylex.props(ops.button)} onClick={close}>
            Back to search
          </button>
          <h1 {...stylex.props(ops.title)}>Import your posts</h1>
          <p {...stylex.props(ops.muted)}>
            Choose an account. We'll download its available history.
          </p>
        </div>
        <span {...stylex.props(connected ? ops.online : ops.error, ops.headerBadge)}>
          {connected ? "Live connection" : "Reconnecting…"}
        </span>
      </header>
      <div {...stylex.props(ops.layout)}>
        <aside>
          <form
            {...stylex.props(ops.form)}
            onSubmit={async (e) => {
              e.preventDefault();
              await run(async () => {
                await ensureSession();
                await start({
                  kind,
                  input,
                  since: kind === "bulk" && since ? since : undefined,
                  refresh: kind === "bulk" && refresh,
                });
              }, "Import started. You can leave this page open or come back later.");
            }}
          >
            <h2 {...stylex.props(ops.heading)}>Start an import</h2>
            <label {...stylex.props(ops.formLabel)}>
              What to download
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
                {...stylex.props(ops.field)}
              >
                <option value="bulk">Account history</option>
                <option value="profile">Profile</option>
                <option value="post">Post / conversation</option>
                <option value="live">Live X search</option>
                <option value="archive">Inspect x.md archive</option>
                <option value="followers">Followers</option>
                <option value="following">Following</option>
              </select>
            </label>
            <label {...stylex.props(ops.formLabel)}>
              {kind === "post" ? "X post URL" : kind === "live" ? "Search query" : "X handle"}
              <input
                id="import-input"
                required
                value={input}
                onChange={(e) => setInput(e.target.value)}
                {...stylex.props(ops.field)}
                placeholder={
                  kind === "post"
                    ? "https://x.com/…/status/…"
                    : kind === "live"
                      ? "convex"
                      : "@handle"
                }
              />
            </label>
            {kind === "bulk" && (
              <>
                <label {...stylex.props(ops.formLabel)}>
                  History since (optional, YYYY-MM-DD)
                  <input
                    inputMode="numeric"
                    pattern="\d{4}-\d{2}-\d{2}"
                    placeholder="YYYY-MM-DD"
                    value={since}
                    onChange={(e) => setSince(e.target.value)}
                    {...stylex.props(ops.field)}
                  />
                </label>
                <label {...stylex.props(ops.formLabel, ops.check)}>
                  <input
                    type="checkbox"
                    checked={refresh}
                    onChange={(e) => setRefresh(e.target.checked)}
                    {...stylex.props(ops.checkbox)}
                  />
                  Fetch fresh data instead of using x.md's cache
                </label>
              </>
            )}
            <button
              type="submit"
              disabled={busy || !config?.indexing}
              {...stylex.props(ops.button, ops.start)}
            >
              {busy
                ? "Starting..."
                : kind === "bulk"
                  ? "Import available history"
                  : "Start download"}
            </button>
            {config && !config.indexing && (
              <p role="status" {...stylex.props(ops.muted)}>
                {indexingUnavailableMessage(config)}
              </p>
            )}
            <p role="status" {...stylex.props(ops.muted)}>
              {message}
            </p>
          </form>
          <section {...stylex.props(ops.connections)}>
            <h2 {...stylex.props(ops.heading)}>Connections</h2>
            {(
              [
                ["x.md", config?.xmd],
                [
                  config?.collectorMode === "outbound" ? "Download worker" : "Local file saving",
                  config?.handoff,
                ],
                ["Search backend", config?.search],
                ["Firecrawl", config?.firecrawl],
                ["OpenAI", config?.openai],
                ["AgentMail", config?.email],
              ] as const
            ).map(([name, ready]) => (
              <div key={name} {...stylex.props(ops.connectionRow)}>
                <span>{name}</span>
                {/* Three different "we don't know" states, and none of them
                    may be rendered as "Not connected": no session means we
                    never asked, `undefined` means the query is in flight or
                    the socket is down, and only a resolved `false` is a fact
                    about configuration. Collapsing them is the
                    configuration-versus-connectivity conflation to-do.md P0
                    calls out. */}
                <span {...stylex.props(ops.connectionState)}>
                  {!isAuthenticated
                    ? "Sign in to view"
                    : !config
                      ? "Checking…"
                      : ready
                        ? "Configured"
                        : "Not connected"}
                </span>
              </div>
            ))}
            <p {...stylex.props(ops.muted)}>
              Configuration status, not a live health check. Provider keys stay on the backend.
            </p>
          </section>
        </aside>
        <div {...stylex.props(ops.main)}>
          <Library ensureSession={ensureSession} />
          <section aria-label="Other imports">
            <h2 {...stylex.props(ops.heading)}>Other imports</h2>
            <p {...stylex.props(ops.muted, ops.feedNote)}>
              Live searches, single posts, profiles, and follower/following lookups. These aren't
              account history imports, so they don't create or update a row in the account library
              above.
            </p>
            {isAuthenticated && (
              <label {...stylex.props(ops.feedToggle)}>
                <input
                  type="checkbox"
                  checked={showDismissed}
                  onChange={(e) => setShowDismissed(e.target.checked)}
                />
                Show runs I've cleared
              </label>
            )}
            {!isAuthenticated ? (
              <button
                {...stylex.props(ops.button)}
                onClick={async () => {
                  try {
                    await ensureSession();
                  } catch {
                    setMessage("Could not start your session.");
                  }
                }}
              >
                Connect to my jobs
              </button>
            ) : !jobs ? (
              <p {...stylex.props(ops.muted)}>Loading jobs…</p>
            ) : jobs.length === 0 ? (
              <div {...stylex.props(ops.empty)}>
                <h3>{showDismissed ? "Nothing here" : "No other imports yet"}</h3>
                <p {...stylex.props(ops.muted)}>
                  {showDismissed
                    ? "You haven't cleared any runs, and there are no others to show."
                    : "Live searches, single posts, and profile/follower lookups will show up here."}
                </p>
              </div>
            ) : (
              jobs.map((job) => <Job key={job._id} job={job} />)
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
