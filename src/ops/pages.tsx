import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Count } from "../../convex/lib/contracts";
import { Avatar } from "../Avatar";
import { Icon } from "../icons";
import { indexingUnavailableMessage } from "../integrationStatus";
import {
  ACCOUNT_FILTERS,
  accountState,
  ago,
  attentionItems,
  canRerun,
  canRetry,
  clock,
  coverage,
  day,
  downloadTotals,
  dt,
  dur,
  hasSearchable,
  hourLabel,
  isActiveJob,
  isStale,
  JOB_PILL,
  jobCollected,
  jobResult,
  jobState,
  jobTarget,
  jobType,
  k,
  lastRefresh,
  n,
  needsHistory,
  pendingLabel,
  queueInfo,
  searchable,
  searchablePosts,
  searchableTotal,
  shortId,
  sortJobs,
  throttledUntil,
  type AccountFilter,
  type Action,
  type Job,
  type OpsAccount,
  type Tone,
} from "./model";
import type { ImportKind, OpsContext } from "./Ops";

type Props = { ops: OpsContext };

const NOT_TRACKED = "not tracked yet";

const count = (c: Count | undefined) => (c?.kind === "known" ? n(c.value) : "—");

const known = (c: Count | undefined) => (c?.kind === "known" ? c.value : 0);

function Loading(): JSX.Element {
  return <p class="ops-loading">Loading…</p>;
}

// --- Shared actions ---------------------------------------------------------

function confirmCancel(ops: OpsContext, job: Job) {
  const target = jobTarget(job).main;
  const waiting = job.status === "queued";

  ops.confirm({
    title: waiting
      ? `Remove ${jobType(job).toLowerCase()} of ${target} from the queue?`
      : `Cancel ${jobType(job).toLowerCase()} of ${target}?`,
    text: waiting
      ? "It hasn't started, so nothing collected is lost."
      : `${jobCollected(job)} so far are kept and stay searchable once indexed. Only the run stops.`,
    yes: waiting ? "Remove job" : "Cancel job",
    run: () => ops.cancel(job._id, `Cancelled ${shortId(job._id)}`),
  });
}

function retryJob(ops: OpsContext, job: Job) {
  void ops.retry(job, `Retrying ${jobType(job).toLowerCase()} of ${jobTarget(job).main}`);
}

function runAction(ops: OpsContext, action: Action) {
  const job = action.jobId ? ops.jobs()?.find((j) => j._id === action.jobId) : undefined;

  switch (action.kind) {
    case "retry":
      if (job) retryJob(ops, job);

      return;
    case "cancel":
      if (job) confirmCancel(ops, job);

      return;
    case "refresh":
      if (action.handle) void ops.refresh([action.handle]);

      return;
    case "search":
      ops.openSearch(`@${action.handle}`);

      return;
    case "logs":
    case "jobs":
      ops.go("jobs");

      return;
    case "provider":
      ops.go("provider");

      return;
    case "performance":
      ops.go("performance");

      return;
    case "accounts":
      ops.go("accounts");
  }
}

function Pill(props: { s: Tone; children: JSX.Element }) {
  return (
    <span class="pill" data-s={props.s}>
      {props.children}
    </span>
  );
}

// --- Overview ---------------------------------------------------------------

export function OverviewPage(props: Props) {
  const ops = props.ops;

  const items = createMemo(() => {
    const jobs = ops.jobs();
    const accounts = ops.accounts();

    if (!jobs || !accounts) return undefined;

    return attentionItems({
      now: ops.now(),
      jobs,
      accounts,
      summary: ops.summary(),
      health: ops.health(),
      limit: ops.limit(),
      config: ops.config(),
    });
  });

  return (
    <>
      <section class="sec" aria-labelledby="ops-attention">
        <div class="sh">
          <h2 id="ops-attention">Needs attention</h2>
          <Show when={items()?.length}>
            <span class="sub">
              {items()!.filter((i) => i.s === "crit").length} need action ·{" "}
              {items()!.filter((i) => i.s !== "crit").length} to watch
            </span>
          </Show>
        </div>
        <div class="att">
          <Show when={items()} fallback={<Loading />}>
            {(list) => (
              <Show
                when={list().length}
                fallback={<div class="none">Nothing needs you right now.</div>}
              >
                {/* Keyed: `items()` is rebuilt on every query update and clock
                    tick, and an unkeyed list would recreate every card each
                    time, replaying its entry animation as a visible flash. */}
                <For each={list()} keyed={(item) => item.key}>
                  {(item) => (
                    <div class="ai" data-s={item().s} data-key={item().key}>
                      <i class="bar" />
                      <div class="body">
                        <b>{item().title}</b>
                        <span>
                          <Show when={item().code}>
                            <code>{item().code}</code>
                          </Show>
                          {item().detail}
                        </span>
                      </div>
                      <div class="acts">
                        <For each={item().actions} keyed={(action) => action.label}>
                          {(action) => (
                            <button
                              type="button"
                              class={["b", action().primary && "p"]}
                              onClick={() => runAction(ops, action())}
                            >
                              {action().label}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            )}
          </Show>
        </div>
      </section>
      <Pipeline ops={ops} />
    </>
  );
}

function Pipeline(props: Props) {
  const ops = props.ops;
  const queue = () => ops.summary()?.queue;

  const stalled = () => ops.jobs()?.filter((j) => jobState(j, ops.now()) === "stalled").length ?? 0;

  const total = () => {
    const accounts = ops.accounts();

    return accounts ? searchableTotal(accounts) : undefined;
  };

  const oneAtATime = () => ops.config()?.collectorMode === "outbound";

  const stages = (): {
    label: string;
    value: string;
    detail: JSX.Element;
    go: "jobs" | "performance" | "accounts";
  }[] => [
    {
      label: "Queued",
      value: count(queue()?.waitingDownloads),
      detail:
        known(queue()?.failedRetryable) > 0 ? (
          <span class="c">{count(queue()?.failedRetryable)} failed, not queued</span>
        ) : (
          "jobs waiting for the worker"
        ),
      go: "jobs",
    },
    {
      label: "Running",
      value: count(queue()?.activeDownloads),
      detail:
        stalled() > 0 ? (
          <span class="w">{stalled()} stalled</span>
        ) : oneAtATime() ? (
          "the worker runs one at a time"
        ) : (
          "jobs downloading now"
        ),
      go: "jobs",
    },
    {
      label: "Awaiting indexing",
      value: count(queue()?.savedCapturesAwaitingIndexing),
      detail: "downloaded batches, not yet searchable",
      go: "performance",
    },
    {
      label: "Searchable",
      value: searchablePosts(total()),
      detail: total()
        ? `posts across ${total()!.accounts} of ${total()!.total} accounts`
        : "posts in the index",
      go: "accounts",
    },
  ];

  return (
    <section class="sec" aria-labelledby="ops-pipeline">
      <div class="sh">
        <h2 id="ops-pipeline">Pipeline</h2>
        <span class="sub">
          Work moves from queued jobs, to downloaded, to searchable. Downloaded posts are not
          searchable until the indexer publishes them.
        </span>
      </div>
      <div class="flowrow">
        <For each={stages()} keyed={(stage) => stage.label}>
          {(stage) => (
            <button
              type="button"
              class="st"
              title={`Open ${stage().go}`}
              onClick={() => ops.go(stage().go)}
            >
              <small>{stage().label}</small>
              <big>{stage().value}</big>
              <div class="d">{stage().detail}</div>
              <i class="arrow" />
            </button>
          )}
        </For>
      </div>
      <Show when={ops.accounts()}>
        {(accounts) => <Coverage accounts={accounts()} now={ops.now()} />}
      </Show>
    </section>
  );
}

function Coverage(props: { accounts: OpsAccount[]; now: number }) {
  const c = () => coverage(props.accounts, props.now);
  const pc = (x: number) => `${c().total ? ((x / c().total) * 100).toFixed(1) : 0}%`;

  return (
    <div class="cov">
      <h3>Coverage across {c().total} accounts</h3>
      <div class="row">
        <span>Complete</span>
        <div class="bar">
          <i class="a" style={{ width: pc(c().complete) }} />
          <i style={{ width: "2px" }} />
          <i class="b2" style={{ width: pc(c().history) }} />
          <i style={{ width: "2px" }} />
          <i class="c" style={{ width: pc(c().newer) }} />
        </div>
        <span>
          {c().complete} / {c().total}
        </span>
      </div>
      <div class="k">
        <span>
          <i style={{ background: "var(--ok)" }} />
          {c().complete} complete as far as we know
        </span>
        <span>
          <i style={{ background: "var(--warn)" }} />
          {c().history} missing older history
        </span>
        <span>
          <i style={{ background: "var(--crit)" }} />
          {c().newer} missing recent posts
        </span>
        <span>
          <i style={{ background: "var(--line)" }} />
          {c().none} nothing searchable yet
        </span>
        <Show when={c().unrecorded}>
          <span>
            <i style={{ background: "var(--faint)" }} />
            {c().unrecorded} searchable, no import run on record
          </span>
        </Show>
      </div>
    </div>
  );
}

// --- Performance ------------------------------------------------------------

type Card = { s: Tone | "none"; b: string; t: JSX.Element; go: "provider" | "jobs" | "accounts" };

export function PerformancePage(props: Props) {
  const ops = props.ops;

  const service = (name: "indexer" | "receiver" | "search") =>
    ops.health()?.find((s) => s.service === name);

  const cards = (): Card[] => {
    const now = ops.now();
    const jobs = ops.jobs() ?? [];
    const states = jobs.map((j) => jobState(j, now));
    const tally = (s: string) => states.filter((x) => x === s).length;
    const until = throttledUntil(ops.limit(), now);
    const backlog = ops.summary()?.queue.savedCapturesAwaitingIndexing;
    const worker = ops.worker();

    const serviceCard = (
      name: "indexer" | "receiver" | "search",
      label: string,
      ok: string,
    ): Card => {
      const s = service(name);

      if (!s || s.kind === "unknown")
        return { s: "none", b: label, t: s ? "Has never reported" : "Loading…", go: "accounts" };

      if (!s.healthy)
        return {
          s: "crit",
          b: label,
          t: (
            <>
              Failing · <code>{s.lastError?.message ?? "no error text"}</code>
            </>
          ),
          go: "accounts",
        };

      if (s.stale)
        return {
          s: "warn",
          b: label,
          t: `Last report ${ago(now - (s.lastHeartbeatAt ?? s.observedAt))}, healthy then`,
          go: "accounts",
        };

      return { s: "ok", b: label, t: ok, go: "accounts" };
    };

    const total = ops.accounts() ? searchableTotal(ops.accounts()!) : undefined;
    const search = ops.activity()?.search;

    return [
      {
        s: until !== undefined ? "warn" : ops.limit() ? "ok" : "none",
        b: "x.md provider",
        t:
          until !== undefined ? (
            <>
              Rate limited · resumes <code>{clock(until)}</code>
            </>
          ) : ops.limit() ? (
            "Available · no active rate limit"
          ) : (
            "Loading…"
          ),
        go: "provider",
      },
      serviceCard(
        "search",
        "Search",
        `Serving · ${total?.kind === "known" ? `${n(total.posts)} posts indexed` : "index size unknown"}${search?.p95Ms !== undefined ? ` · p95 ${Math.round(search.p95Ms)} ms` : ""}`,
      ),
      serviceCard(
        "indexer",
        "Indexer",
        backlog?.kind === "known" && backlog.value > 0
          ? `${n(backlog.value)} downloaded batches not yet searchable`
          : backlog?.kind === "known"
            ? "Caught up"
            : "Healthy · backlog unknown",
      ),
      serviceCard("receiver", "Capture receiver", "Accepting downloads"),
      {
        s:
          worker?.kind === "offline" || tally("failed") || tally("stalled")
            ? "crit"
            : worker
              ? "ok"
              : "none",
        b: "Worker",
        t: `${worker?.kind === "offline" ? "Offline · " : ""}${tally("running")} running · ${tally("waiting")} waiting · ${tally("stalled")} stalled · ${tally("failed")} failed`,
        go: "jobs",
      },
    ];
  };

  return (
    <>
      <section class="sec" aria-labelledby="ops-health">
        <div class="sh">
          <h2 id="ops-health">Service health</h2>
          <span class="sub">Each card opens the page where you can act on it.</span>
        </div>
        <div class="health">
          <For each={cards()} keyed={(card) => card.b}>
            {(card) => (
              <button type="button" class="hc" data-s={card().s} onClick={() => ops.go(card().go)}>
                <i class="dot" />
                <b>{card().b}</b>
                <span>{card().t}</span>
              </button>
            )}
          </For>
        </div>
      </section>
      <section class="sec">
        <Backlog ops={ops} />
      </section>
      <section class="sec">
        <div class="pipe">
          <Throughput ops={ops} />
          <SearchStats ops={ops} />
        </div>
      </section>
    </>
  );
}

function Backlog(props: Props) {
  const ops = props.ops;
  const backlog = () => ops.summary()?.queue.savedCapturesAwaitingIndexing;
  const totals = () => downloadTotals(ops.activity());

  const parts = () =>
    (ops.accounts() ?? [])
      .filter((a) => (a.publication?.pendingWork?.count ?? 0) > 0)
      .map((a) => ({ handle: a.handle, work: a.publication!.pendingWork! }))
      .sort((x, y) => y.work.count - x.work.count);

  // One bar only when every account reported in the same unit; widths in
  // mixed units would compare files with posts.
  const sameUnit = () => new Set(parts().map((p) => p.work.unit)).size === 1;
  const partTotal = () => parts().reduce((sum, p) => sum + p.work.count, 0) || 1;

  return (
    <div class="bl">
      <div class="bh">
        <h3>Downloaded → searchable</h3>
        <span>now</span>
      </div>
      <div class="bb">
        <div class="hero">
          <big>{count(backlog())}</big>
          <small>downloaded batches, not yet searchable</small>
        </div>
        <div>
          <div class="stats">
            <div>
              <b>{totals() ? `${k(totals()!.lastHour)}` : "—"}</b>
              <span>post records downloaded in the last hour</span>
            </div>
            <div>
              <b class="nt">—</b>
              <span>indexing rate · {NOT_TRACKED}</span>
            </div>
            <div>
              <b class="nt">—</b>
              <span>oldest waiting · {NOT_TRACKED}</span>
            </div>
          </div>
          <p class="v">
            The indexer confirms each account's batches as it publishes them, but doesn't report its
            throughput, so there is no estimate for when the backlog clears. Backlog history over
            time is {NOT_TRACKED}.
          </p>
        </div>
      </div>
      <Show when={parts().length}>
        <Show when={sameUnit()}>
          <div class="bar">
            <For each={parts()} keyed={(p) => p.handle}>
              {(p) => (
                <i style={{ width: `${((p().work.count / partTotal()) * 100).toFixed(1)}%` }} />
              )}
            </For>
          </div>
        </Show>
        <div class="leg">
          <For each={parts()} keyed={(p) => p.handle}>
            {(p) => (
              <span>
                <i />
                <b>@{p().handle}</b> · {n(p().work.count)}{" "}
                {p().work.unit === "captures" ? "batches" : p().work.unit} pending
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const rough = max / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;

  return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
}

function Throughput(props: Props) {
  const ops = props.ops;

  const W = 460,
    H = 150,
    PL = 34,
    PB = 22,
    PT = 8;

  return (
    <div class="chart">
      <Show when={ops.activity()} fallback={<Loading />}>
        {(activity) => {
          const hours = () => activity().downloads.hours;
          const max = () => Math.max(1, ...hours().map((h) => h.posts + h.other)) * 1.08;
          const bw = () => (W - PL) / hours().length;
          const sy = (v: number) => H - PB - (v / max()) * (H - PB - PT);
          const totals = () => downloadTotals(activity())!;

          return (
            <>
              <h3>
                <b>Last 24 h</b>
                {n(totals().posts)} post records · {n(totals().other)} other records downloaded
              </h3>
              <div class="lg">
                <span>
                  <i style={{ background: "var(--info)" }} />
                  Post records
                </span>
                <span>
                  <i style={{ background: "var(--faint)" }} />
                  Profiles and follow lists
                </span>
                <span style={{ "margin-left": "auto" }}>indexed per hour: {NOT_TRACKED}</span>
              </div>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label="Records downloaded per hour, last 24 hours"
              >
                <For each={niceTicks(max())}>
                  {(t) => (
                    <>
                      <line
                        x1={PL}
                        x2={W}
                        y1={sy(t)}
                        y2={sy(t)}
                        stroke="var(--line)"
                        stroke-width="1"
                      />
                      <text class="tt" x={PL - 6} y={sy(t) + 4} text-anchor="end">
                        {k(t)}
                      </text>
                    </>
                  )}
                </For>
                <For each={hours()}>
                  {(h, i) => {
                    const x = () => PL + i() * bw();

                    return (
                      <g>
                        <title>
                          {hourLabel(h.start)} · {n(h.posts)} post records · {n(h.other)} other
                        </title>
                        <rect
                          x={x()}
                          y={sy(h.posts)}
                          width={bw() - 3}
                          height={H - PB - sy(h.posts)}
                          rx="2"
                          fill="var(--info)"
                          opacity=".9"
                        />
                        <rect
                          x={x()}
                          y={sy(h.posts + h.other)}
                          width={bw() - 3}
                          height={sy(h.posts) - sy(h.posts + h.other)}
                          rx="2"
                          fill="var(--faint)"
                          opacity=".7"
                        />
                        <rect x={x() - 1} y="0" width={bw()} height={H - PB} fill="transparent" />
                      </g>
                    );
                  }}
                </For>
                <line x1={PL} x2={W} y1={H - PB} y2={H - PB} stroke="var(--field-line)" />
                <For each={[0, 6, 12, 18, 23]}>
                  {(i) => (
                    <text class="tt" x={PL + i * bw() + bw() / 2} y={H - 6} text-anchor="middle">
                      {i === 23 ? "now" : hourLabel(hours()[i].start)}
                    </text>
                  )}
                </For>
              </svg>
              <Show when={activity().downloads.truncated}>
                <p class="note">
                  More than 5,000 batches in the last day; the oldest are left out.
                </p>
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

function SearchStats(props: Props) {
  const ops = props.ops;
  const total = () => (ops.accounts() ? searchableTotal(ops.accounts()!) : undefined);

  const lastPublished = () => {
    const times = (ops.accounts() ?? [])
      .map((a) => a.publication?.lastPublishedAt)
      .filter((t): t is number => t !== undefined);

    return times.length ? Math.max(...times) : undefined;
  };

  const ms = (value: number | undefined) => (value === undefined ? "—" : `${Math.round(value)} ms`);

  return (
    <div class="chart">
      <h3>
        <b>Search · last 24 h</b>
      </h3>
      <Show when={ops.activity()?.search} fallback={<Loading />}>
        {(s) => (
          <>
            <div class="srch">
              <div>
                <b>
                  {n(s().queries)}
                  {s().truncated ? "+" : ""}
                </b>
                <span>queries</span>
              </div>
              <div>
                <b>{n(s().failed)}</b>
                <span>failed queries</span>
              </div>
              <div>
                <b>{ms(s().medianMs)}</b>
                <span>median response</span>
              </div>
              <div>
                <b>{ms(s().p95Ms)}</b>
                <span>p95 response</span>
              </div>
              <div>
                <b>{searchablePosts(total())}</b>
                <span>posts in the index</span>
              </div>
              <div>
                <b>{lastPublished() ? ago(ops.now() - lastPublished()!) : "—"}</b>
                <span>index last updated</span>
              </div>
            </div>
            <p class="note">
              {s().timedSample
                ? `Response times come from the ${s().timedSample} searches run with “Stats for nerds”; other searches aren't timed.`
                : "Response times are only recorded for searches run with “Stats for nerds”; none ran in the last day."}
            </p>
          </>
        )}
      </Show>
    </div>
  );
}

// --- Accounts ---------------------------------------------------------------

function Span(props: { a: OpsAccount; now: number }) {
  const a = () => props.a;
  const running = () => a().latestRun?.status === "running";

  return (
    <Show
      when={a().oldestCollected}
      fallback={
        <div class="span">
          <div class="rr">
            <span>
              {running() ? "Downloading · not searchable yet" : "Nothing collected on record"}
            </span>
          </div>
          <div class="tl">
            <i class={running() ? "pend" : "unk"} style={{ left: 0, right: 0 }} />
          </div>
          <div class="rr">
            <span>{a().joined ? `on X since ${dt(a().joined)}` : ""}</span>
            <span />
          </div>
        </div>
      }
    >
      {(oldest) => {
        const joined = () => a().joined?.slice(0, 10);
        const missing = () => needsHistory(a()) && !!joined() && joined()! < oldest();
        const refreshed = () => lastRefresh(a()) ?? props.now;
        const start = () => Date.parse(missing() ? joined()! : oldest());
        const span = () => Math.max(1, props.now - start());
        const at = (t: number) => `${(((t - start()) / span()) * 100).toFixed(2)}%`;
        const stale = () => isStale(a(), props.now);

        return (
          <div class="span">
            <div class="rr">
              <span>{dt(oldest())}</span>
              <span>{lastRefresh(a()) ? day(refreshed()) : "—"}</span>
            </div>
            <div class="tl">
              <Show when={missing()}>
                <i
                  class="gap"
                  style={{ left: 0, width: at(Date.parse(oldest())) }}
                  title={`On X since ${dt(joined())}, collected from ${dt(oldest())}`}
                />
              </Show>
              <i
                style={{
                  left: at(Date.parse(oldest())),
                  right: `${(100 - parseFloat(at(refreshed()))).toFixed(2)}%`,
                }}
              />
              <Show when={stale()}>
                <i
                  class="unk"
                  style={{ left: at(refreshed()), right: 0 }}
                  title={`Nothing collected after ${day(refreshed())}`}
                />
              </Show>
            </div>
            <div class="rr">
              <span>
                {missing()
                  ? `missing ${dt(joined())} → ${dt(oldest())}`
                  : needsHistory(a())
                    ? "older history not collected yet"
                    : a().backfill?.status === "complete"
                      ? "full history collected"
                      : "no known gaps"}
              </span>
              <span>{a().joined ? "" : "join date unknown"}</span>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

export function AccountsPage(props: Props) {
  const ops = props.ops;
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<AccountFilter>("all");
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());

  const matching = () => {
    const f = ACCOUNT_FILTERS.find((x) => x[0] === filter())![2];
    const q = query().toLowerCase().trim();

    return (ops.accounts() ?? [])
      .filter((a) => f(a, ops.now()))
      .filter((a) => !q || a.handle.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
  };

  const toggle = (handle: string, on: boolean) => {
    const next = new Set(selected());

    if (on) next.add(handle);
    else next.delete(handle);
    setSelected(next);
  };

  const busyAccount = (a: OpsAccount) =>
    [a.latestRun, a.historyRun].some((r) => r?.status === "queued" || r?.status === "running");

  const total = () => (ops.accounts() ? searchableTotal(ops.accounts()!) : undefined);

  return (
    <section class="sec" aria-labelledby="ops-accounts">
      <div class="sh">
        <h2 id="ops-accounts">Accounts</h2>
        <Show when={ops.accounts()}>
          <span class="sub">
            {n(ops.accounts()!.length)}
            {ops.accountsTruncated() ? "+" : ""} accounts · {searchablePosts(total())} searchable
            posts · {count(ops.summary()?.queue.savedCapturesAwaitingIndexing)} downloaded batches
            not yet searchable
          </span>
        </Show>
        <span class="end">
          <button
            type="button"
            class="b p"
            onClick={() => {
              ops.setImportKind("bulk");
              ops.go("imports");
            }}
          >
            <Icon name="plus" size={15} />
            Import account
          </button>
        </span>
      </div>
      <div class="tw">
        <div class="tools">
          <label class="q">
            <Icon name="search" size={16} />
            <span class="sr">Filter accounts</span>
            <input
              type="search"
              placeholder="Filter by handle or name"
              autocomplete="off"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
          <div class="seg" role="group" aria-label="Filter accounts">
            <For each={ACCOUNT_FILTERS}>
              {([id, label, f]) => (
                <button
                  type="button"
                  aria-pressed={filter() === id ? "true" : "false"}
                  data-f={id}
                  onClick={() => setFilter(id)}
                >
                  {label}
                  <span class="n">
                    {(ops.accounts() ?? []).filter((a) => f(a, ops.now())).length}
                  </span>
                </button>
              )}
            </For>
          </div>
          <div class="bulk">
            <Show
              when={selected().size}
              fallback={<span class="faint">Select rows for bulk actions</span>}
            >
              <span>{selected().size} selected</span>
              <button
                type="button"
                class="b"
                onClick={async () => {
                  const handles = [...selected()];

                  if (await ops.refresh(handles)) setSelected(new Set<string>());
                }}
              >
                Refresh selected
              </button>
              <button type="button" class="b s" onClick={() => setSelected(new Set<string>())}>
                Clear
              </button>
            </Show>
          </div>
        </div>
        <div class="scroll">
          <table class="t">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all shown"
                    checked={
                      matching().length > 0 && matching().every((a) => selected().has(a.handle))
                    }
                    onChange={(e) => {
                      const next = new Set(selected());

                      for (const a of matching())
                        if (e.currentTarget.checked) next.add(a.handle);
                        else next.delete(a.handle);
                      setSelected(next);
                    }}
                  />
                </th>
                <th>Account</th>
                <th>Status</th>
                <th class="num">Searchable</th>
                <th class="num">Awaiting index</th>
                <th>Collected range and coverage</th>
                <th>Last refresh</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <Show
                when={ops.accounts()}
                fallback={
                  <tr>
                    <td colspan="8" class="muted empty">
                      Loading…
                    </td>
                  </tr>
                }
              >
                <For
                  each={matching()}
                  keyed={(a) => a.handle}
                  fallback={
                    <tr>
                      <td colspan="8" class="muted empty">
                        No accounts match.
                      </td>
                    </tr>
                  }
                >
                  {(a) => {
                    const state = () => accountState(a(), ops.now());
                    const refreshed = () => lastRefresh(a());
                    const stale = () => isStale(a(), ops.now());
                    const run = () => a().latestRun;

                    return (
                      <tr data-account={a().handle}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select @${a().handle}`}
                            checked={selected().has(a().handle)}
                            onChange={(e) => toggle(a().handle, e.currentTarget.checked)}
                          />
                        </td>
                        <td>
                          <div class="acc">
                            <Avatar name={a().name} url={a().avatar} fallbackClass="ops-av" />
                            <div>
                              <b>@{a().handle}</b>
                              <small>{a().name}</small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <Pill s={state().s}>{state().t}</Pill>
                          <Show when={run()?.status === "running" && run()}>
                            {(r) => (
                              <div class="prog">
                                <div class="tl">
                                  <i class="ind" />
                                </div>
                                <small>{n(r().postsReceived ?? 0)} so far · total unknown</small>
                              </div>
                            )}
                          </Show>
                        </td>
                        <td class="num">
                          {/* No count reported is unknown, not 0 (convex/library.ts). */}
                          {a().publication?.searchablePostCount === undefined ? (
                            <span class="faint" title="The indexer has not reported a count">
                              unknown
                            </span>
                          ) : searchable(a()) ? (
                            n(searchable(a()))
                          ) : (
                            <span class="faint">0</span>
                          )}
                        </td>
                        <td class="num">
                          {pendingLabel(a()) ? (
                            <span class="info">{pendingLabel(a())}</span>
                          ) : (
                            <span class="faint">—</span>
                          )}
                        </td>
                        <td>
                          <Span a={a()} now={ops.now()} />
                        </td>
                        <td class={stale() ? "warn" : "muted"}>
                          {refreshed() ? (
                            ago(ops.now() - refreshed()!)
                          ) : (
                            <span class="faint">never</span>
                          )}
                          <Show when={run()?.status === "failed" || run()?.status === "partial"}>
                            <div class="err">failed · see jobs</div>
                          </Show>
                        </td>
                        <td>
                          <div class="acts">
                            <button
                              type="button"
                              class="ib2"
                              title={`Search @${a().handle}’s posts`}
                              aria-label={`Search @${a().handle}’s posts`}
                              disabled={!hasSearchable(a())}
                              onClick={() => ops.openSearch(`@${a().handle}`)}
                            >
                              <Icon name="search" size={15} />
                            </button>
                            <button
                              type="button"
                              class="ib2"
                              title="Refresh: collect newer posts"
                              aria-label={`Refresh @${a().handle}`}
                              disabled={busyAccount(a())}
                              onClick={() => void ops.refresh([a().handle])}
                            >
                              <Icon name="refresh-cw" size={15} />
                            </button>
                            <a
                              class="ib2"
                              href={`https://x.com/${a().handle}`}
                              target="_blank"
                              rel="noreferrer"
                              title="Open on X"
                              aria-label={`Open @${a().handle} on X`}
                            >
                              <Icon name="arrow-up-right" size={15} />
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </Show>
            </tbody>
          </table>
        </div>
        <Show when={ops.accountsTruncated()}>
          <p class="note pad">Showing the newest 500 accounts.</p>
        </Show>
      </div>
    </section>
  );
}

// --- Jobs -------------------------------------------------------------------

export function JobsPage(props: Props) {
  const ops = props.ops;
  const [view, setView] = createSignal<"active" | "history">("active");
  const now = () => ops.now();
  const all = () => ops.jobs() ?? [];
  const active = () => all().filter((j) => isActiveJob(jobState(j, now())));
  const history = () => all().filter((j) => !isActiveJob(jobState(j, now())));
  const shown = () => sortJobs(view() === "active" ? active() : history(), now());
  const queue = () => queueInfo(ops.timeline());

  return (
    <section class="sec jobs" aria-labelledby="ops-jobs">
      <div class="sh">
        <h2 id="ops-jobs">Jobs</h2>
        <span class="sub">
          {view() === "active"
            ? "Failed jobs stay until retried or dismissed. Stalled means no progress for 10 minutes."
            : "Finished and cancelled runs. Clearing removes the record only; posts stay."}
        </span>
        <span class="end">
          <div class="seg" role="group" aria-label="Job list">
            <button
              type="button"
              aria-pressed={view() === "active" ? "true" : "false"}
              onClick={() => setView("active")}
            >
              Active<span class="n">{active().length}</span>
            </button>
            <button
              type="button"
              aria-pressed={view() === "history" ? "true" : "false"}
              onClick={() => setView("history")}
            >
              History<span class="n">{history().length}</span>
            </button>
          </div>
          <button
            type="button"
            class="b"
            disabled={view() !== "history" || history().length === 0}
            title={
              view() === "history"
                ? "Remove finished and cancelled runs from history"
                : "Switch to History to clear finished runs"
            }
            onClick={() => {
              const ids = history().map((j) => j._id);

              ops.confirm({
                title: `Clear ${ids.length} finished runs?`,
                text: "Removes the run records from history. Nothing collected is deleted; posts stay searchable.",
                yes: "Clear history",
                run: () => ops.dismissAll(ids, `Cleared ${ids.length} runs`),
              });
            }}
          >
            Clear finished
          </button>
        </span>
      </div>
      <div class="tw">
        <table class="t">
          <colgroup>
            <col class="c1" />
            <col class="c2" />
            <col class="c3" />
            <col class="c4" />
            <col class="c5" />
            <col class="c6" />
            <col class="c7" />
          </colgroup>
          <thead>
            <tr>
              <th>Job</th>
              <th>Target</th>
              <th>State</th>
              <th>Progress</th>
              <th>Timing</th>
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <Show
              when={ops.jobs()}
              fallback={
                <tr>
                  <td colspan="7" class="muted empty">
                    Loading…
                  </td>
                </tr>
              }
            >
              <For
                each={shown()}
                keyed={(job) => job._id}
                fallback={
                  <tr>
                    <td colspan="7" class="muted empty">
                      {view() === "active" ? "No active jobs." : "History is empty."}
                    </td>
                  </tr>
                }
              >
                {(job) => <JobRow ops={ops} job={job()} info={queue().get(job()._id)} />}
              </For>
            </Show>
          </tbody>
        </table>
      </div>
      <Show when={ops.jobsTruncated() || all().length >= 100}>
        <p class="note">Showing the newest {all().length} runs.</p>
      </Show>
    </section>
  );
}

function JobRow(props: {
  ops: OpsContext;
  job: Job;
  info: { position?: number; finish?: number } | undefined;
}) {
  const ops = props.ops;
  const job = () => props.job;
  const state = () => jobState(job(), ops.now());
  const target = () => jobTarget(job());

  const timing = () => {
    const j = job();
    const now = ops.now();

    switch (state()) {
      case "waiting":
        return `queued ${ago(now - j._creationTime)}`;
      case "running":
        return `started ${ago(now - j._creationTime)} · ${props.info?.finish ? `done ≈ ${clock(props.info.finish)}` : "estimate unavailable"}`;
      case "stalled":
        return (
          <>
            started {ago(now - j._creationTime)} ·{" "}
            <span class="crit">no progress {dur(now - j.updatedAt)}</span>
          </>
        );
      default:
        return `${ago(now - j.updatedAt)} · ran ${dur(j.updatedAt - j._creationTime)}`;
    }
  };

  return (
    <tr data-job={job()._id}>
      <td class="nowrap">
        <code class="jid">{shortId(job()._id)}</code>
      </td>
      <td>
        <div class="tgt">
          <span class="ty">{jobType(job())}</span>
          <div>
            <b>{target().main}</b>
            <Show when={target().sub}>
              <br />
              <small>{target().sub}</small>
            </Show>
          </div>
        </div>
      </td>
      <td>
        <Pill s={JOB_PILL[state()].s}>{JOB_PILL[state()].t}</Pill>
      </td>
      <td>
        {state() === "waiting" ? (
          <span class="faint">
            {props.info?.position ? `Position ${props.info.position}` : "Waiting"}
            {props.info?.finish ? ` · done ≈ ${clock(props.info.finish)}` : ""}
          </span>
        ) : state() === "running" || state() === "stalled" ? (
          <div class="prog">
            <div class="tl">
              <i
                class={state() === "running" ? "ind" : ""}
                style={state() === "running" ? undefined : { width: 0 }}
              />
            </div>
            <small>{jobCollected(job())} · total unknown</small>
          </div>
        ) : (
          <span class="faint">{job().pages ? `${n(job().pages!)} batches` : "—"}</span>
        )}
      </td>
      <td>
        <span class="muted">{timing()}</span>
      </td>
      <td>
        {state() === "failed" ? (
          <div class="err">{job().error ?? "No error was recorded"}</div>
        ) : (
          <span class="muted">
            {jobResult(job()) ?? "—"}
            {state() === "cancelled" && job().phase ? ` · ${job().phase}` : ""}
          </span>
        )}
      </td>
      <td>
        <div class="acts">
          <Show when={state() === "running" || state() === "stalled"}>
            <button type="button" class="b s d" onClick={() => confirmCancel(ops, job())}>
              Cancel
            </button>
          </Show>
          <Show when={state() === "waiting"}>
            <button type="button" class="b s d" onClick={() => confirmCancel(ops, job())}>
              Remove
            </button>
          </Show>
          <Show when={state() === "failed"}>
            <Show when={canRetry(job())}>
              <button type="button" class="b s" onClick={() => retryJob(ops, job())}>
                Retry
              </button>
            </Show>
            <button
              type="button"
              class="b s d"
              onClick={() => void ops.dismiss(job()._id, `Dismissed ${shortId(job()._id)}`)}
            >
              Dismiss
            </button>
          </Show>
          <Show when={state() === "done" && canRerun(job())}>
            <button
              type="button"
              class="b s"
              onClick={() =>
                void ops.start(
                  {
                    kind: job().kind,
                    input: job().input,
                    since: job().since,
                    refresh: job().refresh,
                  },
                  `Queued ${jobType(job()).toLowerCase()} of ${target().main}`,
                )
              }
            >
              Run again
            </button>
          </Show>
          <Show when={state() === "cancelled" && canRetry(job())}>
            <button type="button" class="b s" onClick={() => retryJob(ops, job())}>
              Continue
            </button>
          </Show>
        </div>
      </td>
    </tr>
  );
}

// --- Other imports -------------------------------------------------------

type ImportType = {
  kind: ImportKind;
  title: string;
  sub: string;
  desc: string;
  input: string;
  placeholder: string;
  out: [string, string][];
};

export const IMPORTS: ImportType[] = [
  {
    kind: "bulk",
    title: "Account history",
    sub: "An account's posts",
    desc: "Downloads an account's timeline as far back as x.md reaches, then keeps walking older history in the background. Posts become searchable once the indexer publishes them.",
    input: "Handle",
    placeholder: "@handle",
    out: [
      ["Produces", "The account's posts"],
      ["Goes to", "Collection · searchable after indexing"],
    ],
  },
  {
    kind: "post",
    title: "Post / conversation",
    sub: "A post and its thread",
    desc: "Fetches the post at this URL with its thread through x.md. Useful for a post whose author isn't imported.",
    input: "Post URL",
    placeholder: "https://x.com/…/status/…",
    out: [
      ["Produces", "The post and its thread"],
      ["Goes to", "Collection · searchable after indexing"],
    ],
  },
  {
    kind: "live",
    title: "X search results",
    sub: "Live search on X",
    desc: "Runs a query on X through x.md and saves the latest results. X search syntax works (from:, since:, until:, -filter:replies).",
    input: "Query",
    placeholder: "local-first since:2026-09-01 -filter:replies",
    out: [
      ["Produces", "Matching posts, any author"],
      ["Goes to", "Collection · searchable after indexing"],
    ],
  },
  {
    kind: "profile",
    title: "Profile",
    sub: "Bio, counts, join date",
    desc: "Fetches an account's profile only. Doesn't collect posts.",
    input: "Handle",
    placeholder: "@handle",
    out: [
      ["Produces", "Profile record"],
      ["Goes to", "The account's record"],
    ],
  },
  {
    kind: "followers",
    title: "Followers",
    sub: "Who follows an account",
    desc: "Pages through an account's public followers. Saved as records, not as searchable posts.",
    input: "Handle",
    placeholder: "@handle",
    out: [
      ["Produces", "Accounts with profile data"],
      ["Goes to", "Saved records · not searchable"],
    ],
  },
  {
    kind: "following",
    title: "Following",
    sub: "Who an account follows",
    desc: "Same as followers, in the other direction. Handy for finding accounts worth importing.",
    input: "Handle",
    placeholder: "@handle",
    out: [
      ["Produces", "Accounts with profile data"],
      ["Goes to", "Saved records · not searchable"],
    ],
  },
  {
    kind: "archive",
    title: "x.md archive",
    sub: "What x.md already holds",
    desc: "Lists the posts x.md has already indexed for an account.",
    input: "Handle",
    placeholder: "@handle",
    out: [
      ["Produces", "x.md's indexed posts for the account"],
      ["Goes to", "Saved records"],
    ],
  },
];

export function ImportsPage(props: Props) {
  const ops = props.ops;
  const current = () => IMPORTS.find((i) => i.kind === ops.importKind()) ?? IMPORTS[0];
  const [value, setValue] = createSignal("");
  const [since, setSince] = createSignal("");
  const [fresh, setFresh] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let input!: HTMLInputElement;

  const costline = () => {
    const until = throttledUntil(ops.limit(), ops.now());

    const config = ops.config();
    const unavailable = config ? indexingUnavailableMessage(config) : undefined;

    if (unavailable) return unavailable;

    if (ops.worker()?.kind === "offline")
      return "The download worker is offline. Imports can't start until it reconnects.";

    if (until !== undefined) return `x.md is rate limited · new work resumes at ${clock(until)}.`;

    return ops.config()?.collectorMode === "outbound"
      ? "Starts as soon as the worker is free; it runs one job at a time."
      : "Starts as soon as a worker is free.";
  };

  return (
    <section class="sec" aria-labelledby="ops-imports">
      <div class="sh">
        <h2 id="ops-imports">Other imports</h2>
        <span class="sub">
          Fetches through x.md. Each one says what it produces and where it ends up.
        </span>
      </div>
      <div class="imports">
        <div class="list">
          <For each={IMPORTS}>
            {(item) => (
              <button
                type="button"
                aria-pressed={ops.importKind() === item.kind ? "true" : "false"}
                data-imp={item.kind}
                onClick={() => {
                  ops.setImportKind(item.kind);
                  setValue("");
                  input.focus();
                }}
              >
                <b>{item.title}</b>
                <small>{item.sub}</small>
              </button>
            )}
          </For>
        </div>
        <div class="form">
          <h3>{current().title}</h3>
          <p>{current().desc}</p>
          <dl class="out">
            <For each={current().out}>
              {([term, detail]) => (
                <>
                  <dt>{term}</dt>
                  <dd>{detail}</dd>
                </>
              )}
            </For>
          </dl>
          <form
            class="impf"
            onSubmit={async (e) => {
              e.preventDefault();
              const text = value().trim();

              if (!text) {
                input.focus();

                return;
              }

              const bulk = current().kind === "bulk";
              setBusy(true);

              const ok = await ops.start(
                {
                  kind: current().kind,
                  input: text,
                  since: bulk && since() ? since() : undefined,
                  refresh: bulk && fresh() ? true : undefined,
                },
                `Queued ${current().title.toLowerCase()} · ${text}`,
              );

              setBusy(false);

              if (ok) {
                setValue("");
                ops.go("jobs");
              }
            }}
          >
            <label class="sr" for="ops-imp-in">
              {current().input}
            </label>
            <div class="row">
              <div class="q">
                <Icon name={current().kind === "live" ? "search" : "link"} size={16} />
                <input
                  id="ops-imp-in"
                  ref={(el) => {
                    input = el;
                  }}
                  type="text"
                  placeholder={current().placeholder}
                  autocomplete="off"
                  value={value()}
                  onInput={(e) => setValue(e.currentTarget.value)}
                />
              </div>
              <button type="submit" class="b p go" disabled={busy()}>
                {busy() ? "Queueing…" : `Queue ${current().title.toLowerCase()}`}
              </button>
            </div>
            <Show when={current().kind === "bulk"}>
              <div class="row">
                <label class="opt">
                  History since
                  <input
                    type="date"
                    value={since()}
                    onInput={(e) => setSince(e.currentTarget.value)}
                  />
                </label>
                <label class="opt">
                  <input
                    type="checkbox"
                    checked={fresh()}
                    onChange={(e) => setFresh(e.currentTarget.checked)}
                  />
                  Fetch fresh data instead of x.md's cache
                </label>
              </div>
            </Show>
            <div class="costline">{costline()}</div>
          </form>
        </div>
      </div>
    </section>
  );
}

// --- Provider ---------------------------------------------------------------

export function ProviderPage(props: Props) {
  const ops = props.ops;
  const limit = () => ops.limit();
  const until = () => throttledUntil(limit(), ops.now());

  const throttle = () => {
    const l = limit();

    return l?.kind === "throttled" ? l : undefined;
  };

  const remaining = () => {
    const r = throttle()?.remaining;

    return r?.kind === "known" ? r.value : undefined;
  };

  const runs = () => ops.activity()?.jobs;
  const runTotal = () => runs()?.byKind.reduce((sum, r) => sum + r.count, 0) ?? 0;
  const downloads = () => downloadTotals(ops.activity());

  const KIND_LABEL: Record<ImportKind, string> = {
    bulk: "Account history",
    live: "X search and backfill windows",
    post: "Posts / conversations",
    profile: "Profiles",
    followers: "Followers",
    following: "Following",
    archive: "x.md archive",
  };

  return (
    <section class="sec" aria-labelledby="ops-provider">
      <div class="sh">
        <h2 id="ops-provider">Provider · x.md</h2>
        <span class="sub">Every import goes through x.md.</span>
      </div>
      <div class="prov">
        <div class="pc">
          <small>Rate limit</small>
          <Show when={limit()} fallback={<Loading />}>
            <big>
              {until() !== undefined ? "Limited" : "Available"}
              {/* 0 is the case that matters most, so test for a value, not truthiness. */}
              <Show when={remaining() !== undefined}>
                <span class="unit"> {n(remaining()!)} calls left</span>
              </Show>
            </big>
            <div class="d">
              {until() !== undefined
                ? `x.md asked us to wait · new work resumes at ${clock(until()!)}`
                : throttle()
                  ? `Last limited ${ago(ops.now() - throttle()!.observedAt)}; that window has passed`
                  : "x.md has never reported a rate limit here"}
            </div>
            <dl>
              <Show when={throttle()}>
                {(t) => (
                  <>
                    <dt>Operation</dt>
                    <dd>{t().operation}</dd>
                    <dt>x.md said</dt>
                    <dd>{t().reason}</dd>
                  </>
                )}
              </Show>
              <dt>Hourly call budget</dt>
              <dd class="nt">{NOT_TRACKED}</dd>
            </dl>
          </Show>
        </div>
        <div class="pc">
          <small>Last 24 h</small>
          <Show when={runs()} fallback={<Loading />}>
            {(r) => (
              <>
                <big>
                  {n(runTotal())}
                  {r().truncated ? "+" : ""} <span class="unit">runs</span>
                </big>
                <div class="d">
                  {downloads()
                    ? `${n(downloads()!.posts + downloads()!.other)} records downloaded`
                    : ""}
                  {" · "}calls made: {NOT_TRACKED}
                </div>
                <dl>
                  <For each={r().byKind}>
                    {(row) => (
                      <>
                        <dt>{KIND_LABEL[row.kind]}</dt>
                        <dd>{n(row.count)}</dd>
                      </>
                    )}
                  </For>
                </dl>
              </>
            )}
          </Show>
        </div>
        <div class="pc">
          <small>Errors and cost</small>
          <big>
            {runs() ? n(runs()!.failed) : "—"} <span class="unit">failed runs</span>
          </big>
          <div class="d">in the last 24 h</div>
          <dl>
            <dt>Rate-limit responses, 24 h</dt>
            <dd>
              {ops.activity()
                ? `${n(ops.activity()!.throttles.xmd)}${ops.activity()!.throttles.truncated ? "+" : ""}`
                : "—"}
            </dd>
            <dt>Latency per call</dt>
            <dd class="nt">{NOT_TRACKED}</dd>
            <dt>Cost</dt>
            <dd class="nt">{NOT_TRACKED}</dd>
          </dl>
        </div>
      </div>
    </section>
  );
}
