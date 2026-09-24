import { createMemo, createSignal, Errored, For, Match, onSettled, Show, Switch } from "solid-js";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useConvex, useMutation, useQuery } from "../data/convex";
import { describeError } from "../errors";
import { Icon } from "../icons";
import { useDashboardClock, useLiveNow } from "../library/clock";
import { useStableQuery } from "../library/stableQuery";
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
import "./ops.css";

export const TAB_LABEL: Record<OpsTab, string> = {
  overview: "Overview",
  accounts: "Accounts",
  jobs: "Jobs",
  imports: "Other imports",
  performance: "Performance",
  provider: "Provider",
};

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

function useOps(props: DashboardProps) {
  const { isAuthenticated } = useConvex();
  const clockNow = useDashboardClock();
  const liveNow = useLiveNow();
  // "Reload" nudges the query clock past its current value so every
  // clock-bound query resubscribes; the 30-second tick carries on.
  const [reloadedAt, setReloadedAt] = createSignal(0);
  // Queries take the 30-second clock, so they resubscribe twice a minute,
  // not every 5 seconds. What the page derives from them (ages, stalls,
  // whether a rate limit has lifted) reads the exact clock: the bucketed
  // one runs up to 30 seconds ahead.
  const queryNow = () => Math.max(clockNow(), reloadedAt());
  const now = () => liveNow();

  // The real time the query clock last moved, for "Updated".
  const updatedAt = createMemo(() => {
    queryNow();

    return Date.now();
  });

  const signedIn = () => isAuthenticated();
  const operator = () => (signedIn() ? operatorArgs() : "skip");

  const me = useQuery(api.auth.me, () => (signedIn() ? {} : "skip"), { soft: true });

  const accounts = useStableQuery(api.ops.accounts, operator);

  const activity = useStableQuery(api.ops.activity, () =>
    signedIn() ? { now: queryNow(), ...operatorArgs() } : "skip",
  );

  const summary = useStableQuery(api.summary.summary, () =>
    signedIn() ? { now: queryNow() } : "skip",
  );

  const health = useStableQuery(api.summary.health, () =>
    signedIn() ? { now: queryNow() } : "skip",
  );

  const limit = useStableQuery(api.limits.current, () =>
    signedIn() ? { provider: "xmd" as const } : "skip",
  );

  // The worker's 45-second liveness window needs the unbucketed clock
  // (src/library/clock.ts `useLiveNow`).
  const config = useStableQuery(api.integrations.operator, () =>
    signedIn() ? { now: liveNow() } : "skip",
  );

  const timeline = useStableQuery(api.queue.timeline, () =>
    signedIn() ? { now: queryNow(), ...operatorArgs() } : "skip",
  );

  const jobFeed = useStableQuery(api.jobs.list, () => (signedIn() ? { limit: 100 } : "skip"));

  const start = useMutation(api.jobs.start),
    cancel = useMutation(api.jobs.cancel),
    retry = useMutation(api.jobs.retry),
    dismiss = useMutation(api.jobs.dismiss);

  const [confirming, setConfirming] = createSignal<Confirm | null>(null);
  const [toast, setToast] = createSignal("");
  const [importKind, setImportKind] = createSignal<ImportKind>("post");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const say = (message: string) => {
    setToast(message);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(""), 5000);
  };

  /** Run one operator action and say how it went. */
  const perform = async (work: () => Promise<void>, success: string): Promise<boolean> => {
    try {
      await props.ensureSession();
      await work();
      say(success);

      return true;
    } catch (error) {
      say(describeError(error));

      return false;
    }
  };

  const go = (tab: OpsTab) => {
    pushHref(opsPath(tab));
    window.scrollTo(0, 0);
  };

  const token = () => operatorArgs();

  return {
    now,
    queryNow,
    updatedAt,
    tab: () => props.tab,
    go,
    me,
    accounts: () => accounts()?.rows,
    accountsTruncated: () => accounts()?.truncated ?? false,
    activity,
    summary,
    health,
    limit,
    config,
    worker: () => workerState(config(), now()),
    timeline,
    jobs: () => jobFeed()?.jobs,
    jobsTruncated: () => jobFeed()?.truncated ?? false,
    confirming,
    confirm: (c: Confirm) => setConfirming(c),
    closeConfirm: () => setConfirming(null),
    toast,
    say,
    clearToast: () => setToast(""),
    importKind,
    setImportKind,
    openSearch: props.openSearch,
    reload: () => {
      setReloadedAt(Math.max(Date.now(), queryNow() + 1));
      say("Reloaded");
    },
    retry: (job: Job, label: string) =>
      perform(async () => void (await retry({ jobId: job._id, ...token() })), label),
    cancel: (jobId: Id<"jobs">, label: string) =>
      perform(async () => void (await cancel({ jobId, ...token() })), label),
    dismiss: (jobId: Id<"jobs">, label: string) =>
      perform(async () => void (await dismiss({ jobId, ...token() })), label),
    dismissAll: (jobIds: Id<"jobs">[], label: string) =>
      perform(async () => {
        for (const jobId of jobIds) await dismiss({ jobId, ...token() });
      }, label),
    start: (
      args: { kind: ImportKind; input: string; since?: string; refresh?: boolean },
      label: string,
    ) => perform(async () => void (await start({ ...args, ...token() })), label),
    refresh: (handles: string[]) =>
      perform(
        async () => {
          for (const input of handles)
            await start({ kind: "bulk", input, refresh: true, ...token() });
        },
        handles.length === 1
          ? `Queued refresh of @${handles[0]}`
          : `Queued ${handles.length} refreshes`,
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
          Public site ↗
        </button>
      </div>
    </header>
  );
}

function Nav(props: { ops: OpsContext }) {
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
      <span class="now">Updated {clock(props.ops.updatedAt())} · auto-refresh 30 s</span>
      <button type="button" class="b s" aria-label="Reload data" onClick={() => props.ops.reload()}>
        ↻ Reload
      </button>
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
