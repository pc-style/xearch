import { useState } from "react";
import { Match } from "effect";
import { useConvexAuth, useConvexConnectionState, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import "./dashboard.css";
import { indexingUnavailableMessage, OPERATOR_SIGN_IN_NOTICE } from "./integrationStatus";
import { useTask } from "./errors";
import { JobRow } from "./JobRow";
import Library from "./library/Library";
import { useDashboardClock, useLiveNow } from "./library/clock";
import { operatorArgs } from "./operatorToken";
import { useStableQuery } from "./library/stableQuery";

// Exported so tests/dashboard-job-ui.test.ts can render this row in
// isolation (the fake-Convex-client harness pattern tests/library-ui.test.ts
// and tests/jobRow-ui.test.ts already use) without standing up the rest of
// the dashboard page's queries.
export function Job({ job, isOperator }: { job: Doc<"jobs">; isOperator: boolean | undefined }) {
  // convex/_generated/ai/guidelines.md "Do not read the wall clock inside a
  // query" applies just as much to a render body: a bare `Date.now()` here
  // would freeze at whatever instant last re-rendered this row instead of
  // ever advancing on its own, so "Retrying automatically at HH:MM" could
  // sit on the wrong branch indefinitely. `useDashboardClock` is the same
  // subscribed, periodically-refreshing clock src/library/Library.tsx
  // already uses for its own queries.
  const now = useDashboardClock();

  const cancel = useMutation(api.jobs.cancel),
    retry = useMutation(api.jobs.retry),
    dismiss = useMutation(api.jobs.dismiss),
    restore = useMutation(api.jobs.restore);

  // Cancel/Retry/Dismiss all run through JobRow's own `useTask`, which shows
  // a failure in a `role="alert"` line. "Bring back" is rendered by THIS
  // component instead (it's a dashboard-only extra JobRow doesn't know
  // about — see `extraActions` below), so it needs its own `useTask` or a
  // failed restore (session expired, connection lost) would throw into an
  // unhandled rejection with nothing shown to the operator.
  const restoreTask = useTask();

  const dismissed = job.dismissedAt !== undefined;

  return (
    <JobRow
      job={job}
      now={now}
      isOperator={isOperator}
      className={dismissed ? "control-job is-dismissed" : "control-job"}
      onCancel={async (j) => {
        await cancel({ jobId: j._id, ...operatorArgs() });
      }}
      onRetry={async (j) => {
        await retry({ jobId: j._id, ...operatorArgs() });
      }}
      onDismiss={
        dismissed
          ? undefined
          : async (j) => {
              await dismiss({ jobId: j._id, ...operatorArgs() });
            }
      }
      // Clearing a finished run only hides it: the run and the receipts
      // proving its captures were stored are kept, and "Bring back" puts it
      // straight back in the list. Only offered once a run is no longer
      // active — stop it first, or it would keep spending provider
      // allowance with no row left to stop it from. This is a
      // dashboard-only extra: the header modal's job row has no "Show runs
      // I've cleared" toggle to bring anything back into, so it never needs
      // this button (src/JobRow.tsx stays operator-string-free either way).
      // `restore`, like Cancel/Retry/Dismiss, is requireOperator-gated
      // server-side (convex/jobs.ts), so it gets the same disabled+notice
      // treatment as JobRow's own actions rather than a silent ConvexError.
      extraActions={
        !["queued", "running"].includes(job.status) && dismissed ? (
          <>
            <button
              type="button"
              disabled={!isOperator || restoreTask.busy}
              title={isOperator ? undefined : OPERATOR_SIGN_IN_NOTICE}
              onClick={() =>
                void restoreTask.run(() => restore({ jobId: job._id, ...operatorArgs() }))
              }
            >
              Bring back
            </button>
            {restoreTask.message && (
              <span role="alert" className="config-warning">
                {restoreTask.message}
              </span>
            )}
          </>
        ) : undefined
      }
    />
  );
}

export default function Dashboard({
  ensureSession,
  close,
  onOpenQueue,
}: {
  ensureSession: () => Promise<void>;
  close: () => void;
  onOpenQueue: () => void;
}) {
  const { isAuthenticated } = useConvexAuth();
  const connected = useConvexConnectionState().isWebSocketConnected;
  // Cancel/Retry/Dismiss/Restore on a job, and starting one, all require a
  // signed-in OPERATOR (convex/access.ts `requireOperator`), not merely a
  // signed-in session — the dashboard is reachable by URL to any
  // authenticated caller, operator or not. This only drives the disabled+
  // notice treatment below; the server enforces the boundary regardless.
  // `undefined` while loading: buttons stay disabled, but the sign-in notice
  // waits for a confirmed `false` — an operator must not see it on every load.
  const isOperator = useQuery(api.access.isOperator, isAuthenticated ? operatorArgs() : "skip");

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

  // `useStableQuery`: `liveNow` ticks every 5s and a bare `useQuery` would
  // hand every consumer `undefined` on each tick (see src/library/stableQuery.ts).
  const config = useStableQuery(
    api.integrations.operator,
    isAuthenticated ? { now: liveNow } : "skip",
  );

  const [showDismissed, setShowDismissed] = useState(false);

  // Ask the server for exactly the kinds this feed shows. Filtering "bulk"
  // out here, after the server had already limited the page, could hide
  // older non-account runs behind 20 newer account imports.
  const jobFeed = useQuery(
    api.jobs.list,
    isAuthenticated ? { includeDismissed: showDismissed, scope: "other" } : "skip",
  );

  const jobs = jobFeed?.jobs;
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

  const everRan = showDismissed ? (jobs?.length ?? 0) > 0 : (everJobs?.jobs.length ?? 0) > 0;

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
          {/* Reachable from the dashboard nav, per spec. Goes through
              App.tsx's `onOpenQueue` (not a direct `pushLocation` here) so
              the pushed history entry is tracked and QueueTimeline's own
              close can pop it with a real Back instead of rewriting it in
              place (CodeRabbit — a `replaceLocation` close left a duplicate
              dashboard entry on the stack). */}
          <button type="button" onClick={onOpenQueue}>
            Queue
          </button>
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
                  ...operatorArgs(),
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
            <button
              type="submit"
              className="control-start"
              disabled={busy || !config?.indexing || !isOperator}
            >
              {busy ? "Starting..." : kind === "bulk" ? "Import posts" : "Start download"}
            </button>
            {config && !config.indexing && (
              <p role="status">{indexingUnavailableMessage(config)}</p>
            )}
            {/* `jobs.start` is requireOperator-gated server-side
                (convex/access.ts) the same as Cancel/Retry/Dismiss/Restore
                above — a signed-in-but-not-operator caller sees why the
                button is disabled instead of hitting a bare ConvexError. */}
            {isAuthenticated && isOperator === false && (
              <p role="status">{OPERATOR_SIGN_IN_NOTICE}</p>
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
          <Library
            ensureSession={ensureSession}
            config={config}
            liveNow={liveNow}
            onOpenQueue={onOpenQueue}
          />
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
              jobs.map((job) => <Job key={job._id} job={job} isOperator={isOperator} />)
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
