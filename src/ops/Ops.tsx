import { createEffect, createSignal, Errored, For, Match, onSettled, Show, Switch } from "solid-js";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useConvex, useMutation, useQuery } from "../data/convex";
import { describeError } from "../errors";
import { Icon } from "../icons";
import { useLiveNow } from "../library/clock";
import { cooldownLabel } from "../library/cooldown";
import { OPS_TABS, opsPath, pushHref, type OpsTab } from "../locationStore";
import type { DashboardProps } from "../operatorSurface";
import { operatorArgs } from "../operatorToken";
import { clock, workerState, type Job } from "./model";
import {
  AccountsPage,
  ImportsPage,
  JobsPage,
  OverviewPage,
  PerformancePage,
  ProviderPage,
} from "./pages";
import { createDashboardStore, TAB_LABEL, type QueryKey } from "./refresh";
import "./ops.css";

export { TAB_LABEL };

const TAB_DESCRIPTION: Record<OpsTab, string> = {
  overview: "What needs attention, and where posts are in the pipeline.",
  performance:
    "How posts move through download, indexing and search, and whether anything is falling behind.",
  accounts:
    "Every imported account: what is searchable, how far back collection goes, and what each one needs next.",
  jobs: "Queued, running, stalled and failed work, plus the history of previous runs.",
  imports: "One-off fetches for posts, X search results, profiles and follow lists.",
  provider: "x.md rate limits, what ran through it in the last day, and its errors.",
};

export type ImportKind = Job["kind"];

export type Confirm = {
  title: string;
  text: string;
  yes: string;
  run: () => Promise<boolean>;
};

/** Everything a dashboard page reads or does, built once by the shell. */
export type OpsContext = ReturnType<typeof useOps>;

/** What each dashboard read answers with (src/ops/refresh.ts `QueryKey`). */
export type DashboardData = {
  accounts: FunctionReturnType<typeof api.ops.accountsSnapshot>;
  activity: FunctionReturnType<typeof api.ops.activitySnapshot>;
  summary: FunctionReturnType<typeof api.summary.summarySnapshot>;
  health: FunctionReturnType<typeof api.summary.healthSnapshot>;
  limit: FunctionReturnType<typeof api.limits.current>;
  config: FunctionReturnType<typeof api.integrations.operator>;
  timeline: FunctionReturnType<typeof api.queue.timelineSnapshot>;
  jobs: FunctionReturnType<typeof api.jobs.list>;
};

/** One finite read per dashboard query, keyed like `DashboardData`. */
type Reads = { [P in QueryKey]: () => Promise<DashboardData[P]> };

const AFTER_START = " · refresh Jobs to see it";

function useOps(props: DashboardProps) {
  const convex = useConvex();
  const { isAuthenticated } = convex;
  // The exact clock, for ages and stalls on screen. It ticks locally and
  // never reaches the server: no read here happens because time passed.
  const now = useLiveNow();

  const [confirming, setConfirming] = createSignal<Confirm | null>(null);
  const [toast, setToast] = createSignal("");
  const [importKind, setImportKind] = createSignal<ImportKind>("post");
  const [retryAllBusy, setRetryAllBusy] = createSignal(false);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const say = (message: string) => {
    setToast(message);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(""), 5000);
  };

  // Every dashboard read is one finite `query` (src/data/convex.ts), asked
  // with the instant it began as `now`; see src/ops/refresh.ts for when.
  const read = <K extends QueryKey>(key: K, at: number): Promise<DashboardData[K]> => {
    const reads: Reads = {
      accounts: () => convex.query(api.ops.accountsSnapshot, operatorArgs()),
      activity: () => convex.query(api.ops.activitySnapshot, { now: at, ...operatorArgs() }),
      summary: () => convex.query(api.summary.summarySnapshot, { now: at }),
      health: () => convex.query(api.summary.healthSnapshot, { now: at }),
      limit: () => convex.query(api.limits.current, { provider: "xmd" }),
      config: () => convex.query(api.integrations.operator, { now: at }),
      timeline: () => convex.query(api.queue.timelineSnapshot, { now: at, ...operatorArgs() }),
      jobs: () => convex.query(api.jobs.list, { limit: 100, activeFirst: true }),
    };

    return reads[key]();
  };

  const store = createDashboardStore<DashboardData>({ read, say });

  // Arriving on a tab reads what it lacks, once a session exists. A session
  // going away forgets everything read under it.
  createEffect(
    () => ({ tab: props.tab, signedIn: isAuthenticated() }),
    ({ tab, signedIn }) => {
      if (signedIn) store.open(tab, Date.now());
      else store.reset();
    },
  );

  // Identity is the one live read left: it is the session itself, which the
  // hosting app (src/App.tsx) already subscribes to, so this adds nothing.
  const me = useQuery(api.auth.me, () => (isAuthenticated() ? {} : "skip"), { soft: true });

  const start = useMutation(api.jobs.start),
    cancel = useMutation(api.jobs.cancel),
    retry = useMutation(api.jobs.retry),
    dismiss = useMutation(api.jobs.dismiss);

  /** Run one operator action and say how it went. */
  const perform = async (work: () => Promise<void>, success: () => string): Promise<boolean> => {
    try {
      await props.ensureSession();
      await work();
      say(success());

      return true;
    } catch (error) {
      say(describeError(error));

      return false;
    }
  };

  // After the server confirmed an action, the row on screen changes to
  // what convex/jobs.ts wrote — no re-read. Totals wait for Refresh.
  const patchJob = (jobId: Id<"jobs">, change: (job: Job) => Job | null) =>
    store.update("jobs", (feed) => ({
      ...feed,
      jobs: feed.jobs.flatMap((job) => {
        if (job._id !== jobId) return [job];
        const next = change(job);

        return next ? [next] : [];
      }),
    }));

  const dismissOne = async (jobId: Id<"jobs">) => {
    await dismiss({ jobId, ...token() });
    // `jobs.list` leaves dismissed runs out, so the row goes.
    patchJob(jobId, () => null);
  };

  const go = (tab: OpsTab) => {
    pushHref(opsPath(tab));
    window.scrollTo(0, 0);
  };

  const token = () => operatorArgs();

  return {
    now,
    tab: () => props.tab,
    go,
    me,
    accounts: () => store.data("accounts")?.rows,
    accountsTruncated: () => store.data("accounts")?.truncated ?? false,
    activity: () => store.data("activity"),
    summary: () => store.data("summary"),
    health: () => store.data("health"),
    limit: () => store.data("limit"),
    config: () => store.data("config"),
    worker: () => workerState(store.data("config"), now()),
    timeline: () => store.data("timeline"),
    jobs: () => store.data("jobs")?.jobs,
    jobsTruncated: () => store.data("jobs")?.truncated ?? false,
    updatedAt: () => store.updatedAt(props.tab),
    loadError: () => store.error(props.tab),
    busy: () => store.busy(props.tab),
    tabRemaining: (at: number) => store.tabRemaining(props.tab, at),
    allRemaining: (at: number) => store.allRemaining(at),
    refreshTab: () => store.refreshTab(props.tab, Date.now()),
    refreshAll: () => store.refreshAll(props.tab, Date.now()),
    confirming,
    confirm: (c: Confirm) => setConfirming(c),
    closeConfirm: () => setConfirming(null),
    toast,
    say,
    clearToast: () => setToast(""),
    importKind,
    setImportKind,
    openSearch: props.openSearch,
    retryAllBusy,
    retry: (job: Job, label: string) =>
      perform(
        async () => {
          await retry({ jobId: job._id, ...token() });
          patchJob(job._id, (j) => ({
            ...j,
            status: "queued",
            error: undefined,
            retryable: undefined,
            phase: "Retry queued",
            updatedAt: Date.now(),
          }));
        },
        () => label,
      ),
    retryAll: () => {
      if (retryAllBusy()) return Promise.resolve(false);

      setRetryAllBusy(true);
      let queued = 0;

      return perform(
        async () => {
          let failed = 0;
          let firstError = "";
          const ids: Id<"jobs">[] = [];

          for (const status of ["failed", "partial"] as const) {
            let cursor: string | null = null;
            let done = false;

            while (!done) {
              const page: FunctionReturnType<typeof api.jobs.failedForRetry> = await convex.query(
                api.jobs.failedForRetry,
                {
                  status,
                  paginationOpts: { numItems: 100, cursor },
                  ...token(),
                },
              );

              ids.push(...page.jobIds);
              cursor = page.cursor;
              done = page.done;
            }
          }

          for (const jobId of ids) {
            try {
              await retry({ jobId, ...token() });
              queued++;
            } catch (error) {
              failed++;
              firstError ||= describeError(error);
              continue;
            }

            patchJob(jobId, (j) => ({
              ...j,
              status: "queued",
              error: undefined,
              retryable: undefined,
              phase: "Retry queued",
              updatedAt: Date.now(),
            }));
          }

          if (failed > 0)
            throw new Error(`${queued} retries queued; ${failed} failed: ${firstError}`);
        },
        () => (queued ? `Queued ${queued} failed jobs for retry` : "No failed jobs to retry"),
      ).finally(() => setRetryAllBusy(false));
    },
    cancel: (jobId: Id<"jobs">, label: string) =>
      perform(
        async () => {
          await cancel({ jobId, ...token() });
          patchJob(jobId, (j) =>
            j.status === "queued" || j.status === "running"
              ? {
                  ...j,
                  status: "cancelled",
                  phase:
                    "Stopped; an in-flight request may still finish. Retained captures are not deleted.",
                  updatedAt: Date.now(),
                }
              : j,
          );
        },
        () => label,
      ),
    dismiss: (jobId: Id<"jobs">, label: string) =>
      perform(
        () => dismissOne(jobId),
        () => label,
      ),
    // One at a time, each row leaving as its own dismissal is confirmed: a
    // failure part-way leaves the rows already dismissed gone and the rest
    // in place, which is exactly the server's state.
    dismissAll: (jobIds: Id<"jobs">[], label: string) =>
      perform(
        async () => {
          for (const jobId of jobIds) await dismissOne(jobId);
        },
        () => label,
      ),
    start: (
      args: { kind: ImportKind; input: string; since?: string; refresh?: boolean },
      label: string,
    ) =>
      perform(
        async () => void (await start({ ...args, ...token() })),
        () => label + AFTER_START,
      ),
    refresh: (handles: string[]) =>
      perform(
        async () => {
          for (const input of handles)
            await start({ kind: "bulk", input, refresh: true, ...token() });
        },
        () =>
          (handles.length === 1
            ? `Queued refresh of @${handles[0]}`
            : `Queued ${handles.length} refreshes`) + AFTER_START,
      ),
    ensureSession: props.ensureSession,
  };
}

function Header(props: { ops: OpsContext }) {
  // The app knows one identity: this session. A verified email names it;
  // the operator build's own key signs in with an anonymous session.
  const email = () => {
    const me = props.ops.me();

    return me?.emailVerified ? me.email : undefined;
  };

  return (
    <header class="top">
      <button type="button" class="logo press" onClick={() => props.ops.go("overview")}>
        xearch <i>.</i> <span class="ops-word">ops</span>
      </button>
      <div class="who">
        <span class="ring" aria-hidden="true">
          {(email() ?? "o").slice(0, 1).toUpperCase()}
        </span>
        <span>{email() ? `signed in as ${email()}` : "signed in with the operator key"}</span>
        <button type="button" class="b s" onClick={() => props.ops.openSearch()}>
          Search posts
        </button>
      </div>
    </header>
  );
}

function Nav(props: { ops: OpsContext }) {
  const [menu, setMenu] = createSignal(false);
  // A one-second tick for the cooldown countdown only; nothing reads on it.
  const [tick, setTick] = createSignal(Date.now());

  onSettled(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);

    return () => clearInterval(id);
  });

  const tabWait = () => props.ops.tabRemaining(tick());
  const allWait = () => props.ops.allRemaining(tick());

  const updated = () => {
    const at = props.ops.updatedAt();

    if (props.ops.busy()) return at === undefined ? "Loading…" : `Updated ${clock(at)} · reading…`;

    return at === undefined ? "Not loaded yet" : `Updated ${clock(at)}`;
  };

  return (
    <nav class="opsnav" aria-label="Dashboard sections">
      <For each={OPS_TABS}>
        {(tab) => (
          <a
            href={opsPath(tab)}
            class={{ on: props.ops.tab() === tab }}
            aria-current={props.ops.tab() === tab ? "page" : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              props.ops.go(tab);
            }}
          >
            {TAB_LABEL[tab]}
          </a>
        )}
      </For>
      <span class="sp" />
      <span class="now">{updated()}</span>
      <div
        class="rf"
        onFocusOut={(e) => {
          // SAFETY: a focus event's `relatedTarget` is the element gaining
          // focus, or null when focus left the document.
          const next = e.relatedTarget as Node | null;

          if (!e.currentTarget.contains(next)) setMenu(false);
        }}
      >
        <button
          type="button"
          class="b s"
          aria-label={`Refresh ${TAB_LABEL[props.ops.tab()]}`}
          aria-disabled={tabWait() > 0 ? "true" : undefined}
          title={
            tabWait() > 0
              ? `Refresh again in ${cooldownLabel(tabWait())}`
              : `Re-read what the ${TAB_LABEL[props.ops.tab()]} tab shows`
          }
          onClick={() => {
            setMenu(false);
            props.ops.refreshTab();
          }}
        >
          <Icon name="refresh-cw" size={15} />
          <span class="lbl">Refresh</span>
        </button>
        <button
          type="button"
          class="b s dd"
          aria-label="More refresh options"
          aria-haspopup="menu"
          aria-expanded={menu() ? "true" : "false"}
          onClick={() => setMenu(!menu())}
        >
          <Icon name="chevron-down" size={14} />
        </button>
        <Show when={menu()}>
          <div class="menu" role="menu">
            <button
              type="button"
              role="menuitem"
              aria-disabled={allWait() > 0 ? "true" : undefined}
              onClick={() => {
                setMenu(false);
                props.ops.refreshAll();
              }}
            >
              <b>Refresh all</b>
              <small>
                {allWait() > 0
                  ? `Available in ${cooldownLabel(allWait())}`
                  : "Every tab, once every five minutes"}
              </small>
            </button>
          </div>
        </Show>
      </div>
    </nav>
  );
}

function ConfirmDialog(props: { ops: OpsContext; confirm: Confirm }) {
  const [busy, setBusy] = createSignal(false);
  let yes!: HTMLButtonElement;

  onSettled(() => yes.focus());

  return (
    <div
      class="md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ops-md-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") props.ops.closeConfirm();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.ops.closeConfirm();
      }}
    >
      <div class="box">
        <h3 id="ops-md-title">{props.confirm.title}</h3>
        <p>{props.confirm.text}</p>
        <div class="acts">
          <button type="button" class="b" onClick={() => props.ops.closeConfirm()}>
            Keep it
          </button>
          <button
            ref={(el) => {
              yes = el;
            }}
            type="button"
            class="b p"
            disabled={busy()}
            onClick={async () => {
              setBusy(true);
              await props.confirm.run();
              setBusy(false);
              props.ops.closeConfirm();
            }}
          >
            {props.confirm.yes}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Ops(props: DashboardProps) {
  const ops = useOps(props);
  const { isAuthenticated } = useConvex();

  // Every query here needs a session (anonymous is enough; the operator key
  // is the authorization). Start one if this visit has none yet.
  onSettled(() => {
    if (!isAuthenticated()) void props.ensureSession().catch(() => {});
  });

  return (
    <main class="ops">
      <Header ops={ops} />
      <Nav ops={ops} />
      <Show when={props.tab !== "overview"}>
        <p class="pgd">{TAB_DESCRIPTION[props.tab]}</p>
      </Show>
      <Show when={ops.loadError()}>
        {(message) => (
          <div class="ops-error" role="alert">
            <b>This page couldn't load.</b>
            <span>{message()}</span>
          </div>
        )}
      </Show>
      <Errored
        fallback={(error) => (
          <div class="ops-error" role="alert">
            <b>This page couldn't load.</b>
            <span>{describeError(error())}</span>
          </div>
        )}
      >
        <Switch>
          <Match when={props.tab === "overview"}>
            <OverviewPage ops={ops} />
          </Match>
          <Match when={props.tab === "performance"}>
            <PerformancePage ops={ops} />
          </Match>
          <Match when={props.tab === "accounts"}>
            <AccountsPage ops={ops} />
          </Match>
          <Match when={props.tab === "jobs"}>
            <JobsPage ops={ops} />
          </Match>
          <Match when={props.tab === "imports"}>
            <ImportsPage ops={ops} />
          </Match>
          <Match when={props.tab === "provider"}>
            <ProviderPage ops={ops} />
          </Match>
        </Switch>
      </Errored>
      <Show when={ops.confirming()}>{(c) => <ConfirmDialog ops={ops} confirm={c()} />}</Show>
      <Show when={ops.toast()}>
        <div class="toast on" role="status">
          <span>{ops.toast()}</span>
          <button
            type="button"
            class="ib"
            aria-label="Dismiss message"
            onClick={() => ops.clearToast()}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      </Show>
    </main>
  );
}
