import { useState } from "react";
import { Match } from "effect";
import { useConvexAuth, useConvexConnectionState, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import "./dashboard.css";
import { indexingUnavailableMessage } from "./integrationStatus";
import { describeError, useTask } from "./errors";
import { jobLabel, jobSummary, jobWarnings } from "./jobText";
import Library from "./library/Library";
import { useDashboardClock, useLiveNow } from "./library/clock";

function Job({ job }: { job: Doc<"jobs"> }) {
  const [expanded, setExpanded] = useState(false),
    [error, setError] = useState("");

  // convex/_generated/ai/guidelines.md "Do not read the wall clock inside a
  // query" applies just as much to a render body: a bare `Date.now()` here
  // would freeze at whatever instant last re-rendered this row instead of
  // ever advancing on its own, so "Retrying automatically at HH:MM" could
  // sit on the wrong branch indefinitely. `useDashboardClock` is the same
  // subscribed, periodically-refreshing clock src/library/Library.tsx
  // already uses for its own queries.
  const now = useDashboardClock();
  const receipts = useQuery(api.jobs.receipts, expanded ? { jobId: job._id } : "skip");

  const cancel = useMutation(api.jobs.cancel),
    retry = useMutation(api.jobs.retry),
    dismiss = useMutation(api.jobs.dismiss),
    restore = useMutation(api.jobs.restore);

  const act = async <T,>(fn: () => Promise<T>) => {
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
    <article className={dismissed ? "control-job is-dismissed" : "control-job"}>
      <div className="control-job-heading">
        <h3>{job.input}</h3>
        <span className={`job-status ${job.status}`}>{jobLabel(job)}</span>
      </div>
      <p>{jobSummary(job)}</p>
      <p className="control-phase" role="status">
        {job.status === "complete"
          ? job.floorReached
            ? "x.md reached the oldest history it can retrieve. Older posts may still exist on X."
            : // This kind of job (live search, single post, profile, follower
              // lookup, etc.) never creates a searchable account entry — that
              // pipeline is covered per-account in the account library above,
              // which is the only place search-publication state is reported.
              "Saved. This isn't an account import, so it doesn't appear in your account library."
          : job.status === "queued" && job.readyAt !== undefined && job.readyAt > now
            ? // Auto-continuation and backed-off retries both land here: a
              // person never has to ask for the next page or retry a
              // transient failure — convex/jobs.ts `finish` requeues the
              // SAME job on its own. Nothing to click; just when it happens.
              `Retrying automatically at ${new Date(job.readyAt).toLocaleTimeString()}`
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
        {/* Clearing a finished run only hides it: the run and the receipts
            proving its captures were stored are kept, and "Bring back" puts
            it straight back in the list. Never offered while the run is
            still active — stop it first, or it would keep spending provider
            allowance with no row to stop it from. */}
        {!active &&
          (dismissed ? (
            <button onClick={() => act(() => restore({ jobId: job._id }))}>Bring back</button>
          ) : (
            <button onClick={() => act(() => dismiss({ jobId: job._id }))}>Clear from list</button>
          ))}
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
  ensureSession: () => Promise<void>;
  close: () => void;
}) {
  const { isAuthenticated } = useConvexAuth();
  const connected = useConvexConnectionState().isWebSocketConnected;
  // `integrations.operator` requires a session, so asking for it before one
  // exists throws into the app's error boundary — which only offers a
  // reload. The dashboard is reachable directly by URL, so that is a normal
  // first load, not an edge case.
  //
  // `useLiveNow`, not `useDashboardClock`: this feeds convex/worker.ts's
  // tight 45s `isWorkerLive` window (via `config.indexing`/`config.handoff`
  // below), which a bucketed `now` corrupts in either rounding direction —
  // see that hook's comment in src/library/clock.ts. `Job`'s own `now`
  // above is unrelated (a retry-countdown display, not a liveness check)
  // and can stay on the coarser, shared clock.
  const liveNow = useLiveNow();
  const config = useQuery(api.integrations.operator, isAuthenticated ? { now: liveNow } : "skip");
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

  // B7: "Show runs I've cleared" is only worth showing once something has
  // actually run — otherwise it's a checkbox that can never do anything.
  // When `showDismissed` is already true this is the exact same query+args
  // as `jobs` above (a shared subscription, not a second read); when it's
  // false, this is the one extra bounded read that lets the toggle know
  // whether flipping it would reveal anything.
  const everJobs = useQuery(
    api.jobs.list,
    isAuthenticated && !showDismissed ? { includeDismissed: true, scope: "other" } : "skip",
  );

  const everRan = showDismissed ? (jobs?.length ?? 0) > 0 : (everJobs?.length ?? 0) > 0;

  const start = useMutation(api.jobs.start);

  const [kind, setKind] = useState<Doc<"jobs">["kind"]>("bulk"),
    [input, setInput] = useState(""),
    [since, setSince] = useState(""),
    [refresh, setRefresh] = useState(false);

  const { busy, message, setMessage, run } = useTask();

  return (
    <main className="control-room">
      {/* B7: the dashboard used to drop the site's own header entirely and
          show only "Back to search" — this restores the logo half of that
          header (reusing style.css's global .topbar/.wordmark, already
          loaded for the whole app) without touching src/App.tsx, which owns
          the real nav (search, saved searches, bookmarks) that has no
          meaning on this page. */}
      <header className="topbar">
        <button type="button" className="wordmark" onClick={close} aria-label="Xearch home">
          xearch<span className="wordmark-dot">.</span>
        </button>
      </header>
      <header className="control-header">
        <div>
          <button onClick={close}>Back to search</button>
          {/* CodeRabbit (PR #48): the heading used to always say "Import an
              account" even once the Advanced disclosure had a non-bulk kind
              selected, so the submit button started a different job than
              the heading described. */}
          <h1>{kind === "bulk" ? "Import an account" : "Start an import"}</h1>
          <p>
            {kind === "bulk"
              ? "Choose an account. We'll download its available history."
              : "Choose the input for the selected job. We'll run that job."}
          </p>
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
            <h2>Start an import</h2>
            {/* B5: one import form. The header's own "Import an account"
                modal (src/App.tsx) only ever offers the common case — a
                handle, an optional start date, and a submit button — so
                that's what this form leads with too, using the same field
                order and copy. The other job kinds this dashboard can also
                start (profile/post/live search/archive/followers/following)
                are operator tools that never feed search (see the note
                below the account library), so they move behind a disclosure
                instead of sitting in front of every visitor by default. */}
            <label htmlFor="import-input">
              {Match.value(kind).pipe(
                Match.when("post", () => "X post URL"),
                Match.when("live", () => "Search query"),
                Match.orElse(() => "X handle"),
              )}
            </label>
            <input
              id="import-input"
              required
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={Match.value(kind).pipe(
                Match.when("post", () => "https://x.com/…/status/…"),
                Match.when("live", () => "convex"),
                Match.orElse(() => "@handle"),
              )}
            />
            {kind === "bulk" && (
              <>
                <label htmlFor="since">
                  History since <small>Optional, YYYY-MM-DD</small>
                </label>
                <input
                  id="since"
                  inputMode="numeric"
                  pattern="\d{4}-\d{2}-\d{2}"
                  placeholder="YYYY-MM-DD"
                  value={since}
                  onChange={(e) => setSince(e.target.value)}
                />
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
            <details className="control-advanced">
              <summary>Advanced: import something else</summary>
              <label>
                What to download
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(
                      // SAFETY: every <option> below is one of
                      // `Doc<"jobs">["kind"]`'s literal values, so the
                      // <select>'s string value is always one of them too.
                      e.target.value as typeof kind,
                    );
                    setInput("");
                  }}
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
            </details>
            <button type="submit" className="control-start" disabled={busy || !config?.indexing}>
              {busy ? "Starting..." : kind === "bulk" ? "Import posts" : "Start download"}
            </button>
            {config && !config.indexing && (
              <p role="status">{indexingUnavailableMessage(config)}</p>
            )}
            <p role="status">{message}</p>
          </form>
        </aside>
        <div className="control-main">
          {/* CodeRabbit (PR #48): pass this component's own `config`/`liveNow`
              down instead of letting <Library> start a second, independent
              `useLiveNow()` tick and a second `operator` query — two
              separately-ticking clocks would send slightly different `now`
              values, so the two queries would not actually share one Convex
              subscription the way the comment near this file's own `config`
              declaration claims. */}
          <Library ensureSession={ensureSession} config={config} liveNow={liveNow} />
          <section className="control-feed" aria-label="Other imports">
            <h2>Other imports</h2>
            <p className="control-feed-note">
              Live searches, single posts, profiles, and follower/following lookups. These aren't
              account history imports, so they don't create or update a row in the account library
              above.
            </p>
            {/* B7: a checkbox that can never reveal anything is not worth
                showing — only offer it once something has actually run
                (dismissed or not). */}
            {isAuthenticated && everRan && (
              <label className="control-feed-toggle">
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
            ) : jobs.length === 0 ? (
              // B7: one compact line, same shape as the other three "nothing
              // here yet" states this dashboard can show at once (account
              // library, active queue, recent run history) — not its own
              // bigger headline.
              <p className="library-muted">
                {showDismissed
                  ? "You haven't cleared any runs, and there are no others to show."
                  : "Nothing else has run yet. Live searches, single posts, and profile/follower lookups will show up here."}
              </p>
            ) : (
              jobs.map((job) => <Job key={job._id} job={job} />)
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
