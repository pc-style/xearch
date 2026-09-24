import { createSignal, For, Match, Show, Switch } from "solid-js";
import { Match as M } from "effect";
import { useConvex, useMutation, useQuery } from "./data/convex";
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

// Exported so tests/dashboard-job-ui.test.tsx can render this row in
// isolation without standing up the rest of the dashboard page's queries.
export function Job(props: { job: Doc<"jobs">; isOperator: boolean | undefined }) {
  // A bare `Date.now()` would freeze at whatever instant this row was
  // created, so "Retrying automatically at HH:MM" could sit on the wrong
  // branch indefinitely. `useDashboardClock` is the shared ticking clock
  // src/library/Library.tsx uses too.
  const now = useDashboardClock();

  const cancel = useMutation(api.jobs.cancel),
    retry = useMutation(api.jobs.retry),
    dismiss = useMutation(api.jobs.dismiss),
    restore = useMutation(api.jobs.restore);

  // Cancel/Retry/Dismiss report through JobRow's own task. "Bring back" is
  // rendered here (a dashboard-only extra JobRow doesn't know about), so it
  // needs its own, or a failed restore would go unreported.
  const restoreTask = useTask();

  const dismissed = () => props.job.dismissedAt !== undefined;

  return (
    <JobRow
      job={props.job}
      now={now()}
      isOperator={props.isOperator}
      class={dismissed() ? "control-job is-dismissed" : "control-job"}
      onCancel={async (j) => {
        await cancel({ jobId: j._id, ...operatorArgs() });
      }}
      onRetry={async (j) => {
        await retry({ jobId: j._id, ...operatorArgs() });
      }}
      onDismiss={
        dismissed()
          ? undefined
          : async (j) => {
              await dismiss({ jobId: j._id, ...operatorArgs() });
            }
      }
      // Clearing a finished run only hides it; "Bring back" restores it.
      // Only offered once a run is no longer active — stop it first, or it
      // would keep spending provider allowance with no row left to stop it.
      // `restore` is requireOperator-gated server-side like the rest.
      extraActions={
        <Show when={!["queued", "running"].includes(props.job.status) && dismissed()}>
          <button
            type="button"
            disabled={!props.isOperator || restoreTask.busy()}
            title={props.isOperator ? undefined : OPERATOR_SIGN_IN_NOTICE}
            onClick={() =>
              void restoreTask.run(() => restore({ jobId: props.job._id, ...operatorArgs() }))
            }
          >
            Bring back
          </button>
          <Show when={restoreTask.message()}>
            <span role="alert" class="config-warning">
              {restoreTask.message()}
            </span>
          </Show>
        </Show>
      }
    />
  );
}

export default function Dashboard(props: {
  ensureSession: () => Promise<void>;
  close: () => void;
  onOpenQueue: () => void;
}) {
  const { isAuthenticated, connection } = useConvex();
  const connected = () => connection().isWebSocketConnected;

  // Cancel/Retry/Dismiss/Restore and starting an import require an operator
  // (convex/access.ts `requireOperator`). This only drives the disabled +
  // notice treatment; the server enforces the boundary regardless.
  // `undefined` while loading: buttons stay disabled, but the notice waits
  // for a confirmed `false`.
  const isOperator = useQuery(api.access.isOperator, () =>
    isAuthenticated() ? operatorArgs() : "skip",
  );

  // `integrations.operator` requires a session. `useLiveNow`, not the
  // bucketed dashboard clock: this feeds convex/worker.ts's tight 45s
  // `isWorkerLive` window — see src/library/clock.ts.
  const liveNow = useLiveNow();

  // Stable: `liveNow` ticks every 5s, and a plain query would hand every
  // consumer `undefined` on each tick (see src/library/stableQuery.ts).
  const config = useStableQuery(api.integrations.operator, () =>
    isAuthenticated() ? { now: liveNow() } : "skip",
  );

  const [showDismissed, setShowDismissed] = createSignal(false);

  // Ask the server for exactly the kinds this feed shows (non-account
  // runs); account histories live in <Library> above.
  const jobFeed = useQuery(api.jobs.list, () =>
    isAuthenticated() ? { includeDismissed: showDismissed(), scope: "other" as const } : "skip",
  );

  const jobs = () => jobFeed()?.jobs;

  // B7: "Show runs I've cleared" is only worth showing once something has
  // run. When `showDismissed` is on this is the same query as `jobs`.
  const everJobs = useQuery(api.jobs.list, () =>
    isAuthenticated() && !showDismissed()
      ? { includeDismissed: true, scope: "other" as const }
      : "skip",
  );

  const everRan = () =>
    showDismissed() ? (jobs()?.length ?? 0) > 0 : (everJobs()?.jobs.length ?? 0) > 0;

  const start = useMutation(api.jobs.start);

  const [kind, setKind] = createSignal<Doc<"jobs">["kind"]>("bulk"),
    [input, setInput] = createSignal(""),
    [since, setSince] = createSignal(""),
    [refresh, setRefresh] = createSignal(false);

  const { busy, message, setMessage, run } = useTask();

  const inputLabel = () =>
    M.value(kind()).pipe(
      M.when("post", () => "X post URL"),
      M.when("live", () => "Search query"),
      M.orElse(() => "X handle"),
    );

  const inputPlaceholder = () =>
    M.value(kind()).pipe(
      M.when("post", () => "https://x.com/…/status/…"),
      M.when("live", () => "convex"),
      M.orElse(() => "@handle"),
    );

  return (
    <main class="control-room">
      <header class="top">
        <button
          type="button"
          class="logo press"
          onClick={() => props.close()}
          aria-label="Xearch home"
        >
          xearch <i>.</i>
        </button>
      </header>
      <header class="control-header">
        <div>
          <button type="button" onClick={() => props.close()}>
            Back to search
          </button>
          {/* Goes through App.tsx's `onOpenQueue` (not a direct
              `pushLocation` here) so the pushed history entry is tracked and
              QueueTimeline's own close can pop it with a real Back. */}
          <button type="button" onClick={() => props.onOpenQueue()}>
            Queue
          </button>
          <h1>{kind() === "bulk" ? "Import an account" : "Start an import"}</h1>
          <p>
            {kind() === "bulk"
              ? "Choose an account. We'll download its available history."
              : "Choose the input for the selected job. We'll run that job."}
          </p>
        </div>
        <span class={connected() ? "control-online" : "control-error"}>
          {connected() ? "Live connection" : "Reconnecting…"}
        </span>
      </header>
      <div class="control-layout">
        <aside>
          <form
            class="control-form"
            onSubmit={async (e) => {
              e.preventDefault();
              await run(async () => {
                await props.ensureSession();
                await start({
                  kind: kind(),
                  input: input(),
                  since: kind() === "bulk" && since() ? since() : undefined,
                  refresh: kind() === "bulk" && refresh(),
                  ...operatorArgs(),
                });
              }, "Import started. You can leave this page open or come back later.");
            }}
          >
            <h2>Start an import</h2>
            {/* B5: one import form, leading with the common case; the other
                job kinds are operator tools behind a disclosure. */}
            <label for="import-input">{inputLabel()}</label>
            <input
              id="import-input"
              required
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              placeholder={inputPlaceholder()}
            />
            <Show when={kind() === "bulk"}>
              <label for="since">
                History since <small>Optional, YYYY-MM-DD</small>
              </label>
              <input
                id="since"
                inputmode="numeric"
                pattern="\d{4}-\d{2}-\d{2}"
                placeholder="YYYY-MM-DD"
                value={since()}
                onInput={(e) => setSince(e.currentTarget.value)}
              />
              <label class="control-check">
                <input
                  type="checkbox"
                  checked={refresh()}
                  onChange={(e) => setRefresh(e.currentTarget.checked)}
                />
                Fetch fresh data instead of using x.md's cache
              </label>
            </Show>
            <details class="control-advanced">
              <summary>Advanced: import something else</summary>
              <label>
                What to download
                <select
                  onChange={(e) => {
                    // SAFETY: every <option> below is one of
                    // `Doc<"jobs">["kind"]`'s literal values.
                    setKind(e.currentTarget.value as Doc<"jobs">["kind"]);
                    setInput("");
                  }}
                >
                  <For
                    each={
                      [
                        ["bulk", "Account history"],
                        ["profile", "Profile"],
                        ["post", "Post / conversation"],
                        ["live", "Live X search"],
                        ["archive", "Inspect x.md archive"],
                        ["followers", "Followers"],
                        ["following", "Following"],
                      ] as const
                    }
                  >
                    {([value, label]) => (
                      <option value={value} selected={kind() === value}>
                        {label}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </details>
            <button
              type="submit"
              class="control-start"
              disabled={busy() || !config()?.indexing || !isOperator()}
            >
              {busy() ? "Starting..." : kind() === "bulk" ? "Import posts" : "Start download"}
            </button>
            <Show when={config() && !config()!.indexing}>
              <p role="status">{indexingUnavailableMessage(config()!)}</p>
            </Show>
            <Show when={isAuthenticated() && isOperator() === false}>
              <p role="status">{OPERATOR_SIGN_IN_NOTICE}</p>
            </Show>
            <p role="status">{message()}</p>
          </form>
        </aside>
        <div class="control-main">
          {/* This component's own `config`/`liveNow`, so <Library> shares
              the one `operator` subscription instead of starting a second
              clock and a near-duplicate query (CodeRabbit, PR #48). */}
          {/* "Other imports" is passed in as `otherImports` rather than
              rendered as <Library>'s sibling, so it sits after the active
              queue and ahead of the account library — <Library> owns the
              section order. */}
          <Library
            ensureSession={props.ensureSession}
            config={config()}
            liveNow={liveNow()}
            onOpenQueue={props.onOpenQueue}
            otherImports={
              <section class="control-feed" aria-label="Other imports">
                <h2>Other imports</h2>
                <p class="control-feed-note">
                  Live searches, single posts, profiles, and follower/following lookups. These
                  aren't account history imports, so they don't create or update a row in the
                  account library below.
                </p>
                <Show when={isAuthenticated() && everRan()}>
                  <label class="control-feed-toggle">
                    <input
                      type="checkbox"
                      checked={showDismissed()}
                      onChange={(e) => setShowDismissed(e.currentTarget.checked)}
                    />
                    Show runs I've cleared
                  </label>
                </Show>
                <Switch>
                  <Match when={!isAuthenticated()}>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await props.ensureSession();
                        } catch {
                          setMessage("Could not start your session.");
                        }
                      }}
                    >
                      Connect to my jobs
                    </button>
                  </Match>
                  <Match when={!jobs()}>
                    <p>Loading jobs…</p>
                  </Match>
                  <Match when={jobs()!.length === 0}>
                    <p class="library-muted">
                      {showDismissed()
                        ? "You haven't cleared any runs, and there are no others to show."
                        : "Nothing else has run yet. Live searches, single posts, and profile/follower lookups will show up here."}
                    </p>
                  </Match>
                  <Match when={true}>
                    <For each={jobs()} keyed={(job) => job._id}>
                      {(job) => <Job job={job()} isOperator={isOperator()} />}
                    </For>
                  </Match>
                </Switch>
              </section>
            }
          />
        </div>
      </div>
    </main>
  );
}
