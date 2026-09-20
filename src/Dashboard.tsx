import { useState } from "react";
import { useConvexAuth, useConvexConnectionState, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import "./dashboard.css";
import { indexingUnavailableMessage } from "./integrationStatus";
import { describeError } from "./errors";
import { jobLabel, jobSummary, jobWarnings } from "./jobText";
import Library from "./library/Library";

function Job({ job }: { job: Doc<"jobs"> }) {
  const [expanded, setExpanded] = useState(false),
    [error, setError] = useState("");
  const receipts = useQuery(api.jobs.receipts, expanded ? { jobId: job._id } : "skip");
  const cancel = useMutation(api.jobs.cancel),
    retry = useMutation(api.jobs.retry),
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
  return (
    <article className="control-job">
      <div className="control-job-heading">
        <h3>{job.input}</h3>
        <span className={`job-status ${job.status}`}>{jobLabel(job)}</span>
      </div>
      <p>{jobSummary(job)}</p>
      <p className="control-phase" role="status">
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
      <small>
        Updated {new Date(job.updatedAt).toLocaleString()}
        {job.oldest ? ` | Oldest post received: ${new Date(job.oldest).toLocaleDateString()}` : ""}
      </small>
      {job.error && <p className="control-error">{job.error}</p>}
      {jobWarnings(job).map((w) => (
        <p className="control-warning" key={w}>
          {w}
        </p>
      ))}
      <div className="control-actions">
        {active && <button onClick={() => act(() => cancel({ jobId: job._id }))}>Stop job</button>}
        {["failed", "partial", "cancelled"].includes(job.status) && (
          <button onClick={() => act(() => retry({ jobId: job._id }))}>Retry download</button>
        )}
        {job.status === "complete" && (job.nextUntil || job.nextCursor) && (
          <button
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
        <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide technical details" : "Technical details"}
        </button>
      </div>
      {error && (
        <p role="alert" className="control-error">
          {error}
        </p>
      )}
      {expanded && (
        <div className="control-receipts">
          {receipts === undefined
            ? "Loading receipts…"
            : receipts.length === 0
              ? "No durable acknowledgments yet."
              : receipts.map((r) => (
                  <div key={r._id}>
                    <strong>{r.records} saved response files</strong>
                    <code>{r.receiptId}</code>
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
  const config = useQuery(api.integrations.configured, {});
  const jobs = useQuery(api.jobs.list, isAuthenticated ? {} : "skip");
  // Account-history ("bulk") jobs are represented per-account in <Library>
  // above (convex/library.ts groups exactly this kind); this feed exists
  // only for the non-account job kinds to-do.md P0 says must stay out of
  // the indexed-people list (live search, single post, profile, followers,
  // following, archive).
  const otherJobs = jobs?.filter((job) => job.kind !== "bulk") ?? [];
  const start = useMutation(api.jobs.start);
  const [kind, setKind] = useState<Doc<"jobs">["kind"]>("bulk"),
    [input, setInput] = useState(""),
    [since, setSince] = useState(""),
    [refresh, setRefresh] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <main className="control-room">
      <header className="control-header">
        <div>
          <button onClick={close}>Back to search</button>
          <h1>Import your posts</h1>
          <p>Choose an account. We'll download its available history.</p>
        </div>
        <span className={connected ? "control-online" : "control-error"}>
          {connected ? "Live connection" : "Reconnecting…"}
        </span>
      </header>
      <div className="control-layout">
        <aside>
          <form
            className="control-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setMessage("");
              try {
                await ensureSession();
                await start({
                  kind,
                  input,
                  since: kind === "bulk" && since ? since : undefined,
                  refresh: kind === "bulk" && refresh,
                });
                setMessage("Import started. You can leave this page open or come back later.");
              } catch (e) {
                setMessage(describeError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2>Start an import</h2>
            <label>
              What to download
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="bulk">Account history</option>
                <option value="profile">Profile</option>
                <option value="post">Post / conversation</option>
                <option value="live">Live X search</option>
                <option value="archive">Inspect x.md archive</option>
                <option value="followers">Followers</option>
                <option value="following">Following</option>
              </select>
            </label>
            <label>
              {kind === "post" ? "X post URL" : kind === "live" ? "Search query" : "X handle"}
              <input
                id="import-input"
                required
                value={input}
                onChange={(e) => setInput(e.target.value)}
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
                <label>
                  History since (optional, YYYY-MM-DD)
                  <input
                    inputMode="numeric"
                    pattern="\d{4}-\d{2}-\d{2}"
                    placeholder="YYYY-MM-DD"
                    value={since}
                    onChange={(e) => setSince(e.target.value)}
                  />
                </label>
                <label className="control-check">
                  <input
                    type="checkbox"
                    checked={refresh}
                    onChange={(e) => setRefresh(e.target.checked)}
                  />
                  Fetch fresh data instead of using x.md's cache
                </label>
              </>
            )}
            <button type="submit" className="control-start" disabled={busy || !config?.indexing}>
              {busy
                ? "Starting..."
                : kind === "bulk"
                  ? "Import available history"
                  : "Start download"}
            </button>
            {config && !config.indexing && (
              <p role="status">{indexingUnavailableMessage(config)}</p>
            )}
            <p role="status">{message}</p>
          </form>
          <section className="control-connections">
            <h2>Connections</h2>
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
              <div key={name}>
                <span>{name}</span>
                {/* `config` is undefined while the query is in flight or the
                    socket is down. Rendering that as "Not connected" states a
                    fact we do not have yet -- the same configuration-versus-
                    connectivity conflation to-do.md P0 calls out. */}
                <span>{!config ? "Checking…" : ready ? "Configured" : "Not connected"}</span>
              </div>
            ))}
            <p>Configuration status, not a live health check. Provider keys stay on the backend.</p>
          </section>
        </aside>
        <div className="control-main">
          <Library ensureSession={ensureSession} />
          <section className="control-feed" aria-label="Other imports">
            <h2>Other imports</h2>
            <p className="control-feed-note">
              Live searches, single posts, profiles, and follower/following lookups. These aren't
              account history imports, so they don't create or update a row in the account library
              above.
            </p>
            {!isAuthenticated ? (
              <button
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
              <p>Loading jobs…</p>
            ) : otherJobs.length === 0 ? (
              <div className="control-empty">
                <h3>No other imports yet</h3>
                <p>Live searches, single posts, and profile/follower lookups will show up here.</p>
              </div>
            ) : (
              otherJobs.map((job) => <Job key={job._id} job={job} />)
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
