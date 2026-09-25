import { createSignal, type Signal } from "solid-js";
import { OPS_TABS, type OpsTab } from "../locationStore";
import { cooldownLabel, createCooldown, type Cooldown } from "../library/cooldown";
import { capture } from "../posthog";
import { describeError } from "../errors";

/**
 * How the dashboard reads its data: by hand, finitely, and only what the
 * tab on screen shows.
 *
 * The dashboard used to subscribe to every one of its queries from the
 * shell, with a 30-second clock in their arguments, so each open browser
 * re-ran the two broadest reads in the backend (convex/ops.ts `activity`,
 * convex/summary.ts `summary`: hundreds of MB per hour between them) twice
 * a minute AND on every worker write in between — an unattended tab was as
 * expensive as a busy one. Now:
 *
 *   - a tab reads once, the first time it is opened, and only the queries
 *     it does not already have from another tab;
 *   - the refresh control re-reads the current tab's queries, or every
 *     tab's, and nothing else ever re-reads them: not a timer, not a write
 *     on the server, not the page regaining focus;
 *   - each tab has its own cooldown, and Refresh all has a longer one that
 *     also starts every tab's, counted from the moment a read begins;
 *   - cooldowns live in `localStorage`, so a reload buys no extra reads.
 *
 * The store knows nothing about Convex: `read` is handed in (src/ops/Ops.tsx
 * builds it on the app's finite `query`), which is also what the tests use.
 */

export type QueryKey =
  | "accounts"
  | "activity"
  | "summary"
  | "health"
  | "limit"
  | "config"
  | "timeline"
  | "jobs";

/** What each tab reads. A key missing here is never fetched for that tab. */
export const TAB_QUERIES: Record<OpsTab, readonly QueryKey[]> = {
  overview: ["jobs", "accounts", "summary", "health", "limit", "config"],
  performance: ["activity", "accounts", "summary", "health", "limit", "config", "jobs"],
  accounts: ["accounts", "summary"],
  jobs: ["jobs", "timeline"],
  imports: ["limit", "config"],
  provider: ["limit", "activity"],
};

export const TAB_COOLDOWN_MS = 30_000;

export const ALL_COOLDOWN_MS = 5 * 60_000;

export type RefreshScope = "initial" | "tab" | "all";

export type Read<R extends Record<QueryKey, unknown>> = <K extends QueryKey>(
  key: K,
  now: number,
) => Promise<R[K]>;

export type DashboardStoreOptions<R extends Record<QueryKey, unknown>> = {
  read: Read<R>;
  /** Tell the person something (a failed read, a blocked refresh). */
  say: (message: string) => void;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
};

export type DashboardStore<R extends Record<QueryKey, unknown>> = ReturnType<
  typeof createDashboardStore<R>
>;

export const TAB_LABEL: Record<OpsTab, string> = {
  overview: "Overview",
  accounts: "Accounts",
  jobs: "Jobs",
  imports: "Other imports",
  performance: "Performance",
  provider: "Provider",
};

export function createDashboardStore<R extends Record<QueryKey, unknown>>(
  options: DashboardStoreOptions<R>,
) {
  type Slot = { value: R[QueryKey]; fetchedAt: number };

  const keys = new Set<QueryKey>(Object.values(TAB_QUERIES).flat());
  const slots = new Map<QueryKey, Signal<Slot | undefined>>();

  for (const key of keys) slots.set(key, createSignal<Slot | undefined>(undefined));

  const slot = (key: QueryKey) => slots.get(key)!;

  // SAFETY: a slot only ever holds what `read(key, …)` answered for its own
  // key, which `Read<R>` types as `R[K]`; the map just cannot say so per key.
  const value = <K extends QueryKey>(key: K) => slot(key)[0]()?.value as R[K] | undefined;

  const inflight = new Map<QueryKey, Promise<unknown>>();
  const opened = new Set<OpsTab>();

  // SAFETY: built from every member of `OPS_TABS`, so each tab has an entry.
  const cooldowns = Object.fromEntries(
    OPS_TABS.map((tab) => [tab, createCooldown(`ops:${tab}`, TAB_COOLDOWN_MS, options.storage)]),
  ) as Record<OpsTab, Cooldown>;

  const all = createCooldown("ops:all", ALL_COOLDOWN_MS, options.storage);
  const [errors, setErrors] = createSignal<Partial<Record<OpsTab, string>>>({});
  const [busy, setBusy] = createSignal<ReadonlySet<QueryKey>>(new Set());

  const setBusyKeys = (change: (next: Set<QueryKey>) => void) => {
    const next = new Set(busy());
    change(next);
    setBusy(next);
  };

  /** Read `wanted` once each, sharing any read already in flight. */
  const run = async (
    wanted: readonly QueryKey[],
    scope: RefreshScope,
    tab: OpsTab,
    now: number,
  ) => {
    const started = Date.now();
    const fresh = wanted.filter((key) => !inflight.has(key));

    setBusyKeys((next) => {
      for (const key of fresh) next.add(key);
    });

    for (const key of fresh) {
      const promise = options
        .read(key, now)
        .then((answer) => {
          slot(key)[1](() => ({ value: answer, fetchedAt: Date.now() }));
        })
        .finally(() => {
          inflight.delete(key);
          setBusyKeys((next) => next.delete(key));
        });

      inflight.set(key, promise);
    }

    const results = await Promise.allSettled(wanted.map((key) => inflight.get(key)));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");

    const next = { ...errors() };

    // A read that served several tabs clears (or sets) each tab's error.
    for (const other of OPS_TABS)
      if (TAB_QUERIES[other].some((key) => wanted.includes(key))) {
        if (failure) next[other] = describeError(failure.reason);
        else delete next[other];
      }

    setErrors(next);

    if (failure) options.say(describeError(failure.reason));

    capture("ops_dashboard_refresh", {
      scope,
      tab,
      queries: wanted.join(","),
      durationMs: Date.now() - started,
      outcome: failure ? "failed" : "ok",
    });
  };

  const blocked = (scope: "tab" | "all", tab: OpsTab, remaining: number) => {
    capture("ops_dashboard_refresh_blocked", { scope, tab, remainingMs: remaining });
    options.say(
      scope === "all"
        ? `Refresh all again in ${cooldownLabel(remaining)}.`
        : `Refresh ${TAB_LABEL[tab]} again in ${cooldownLabel(remaining)}.`,
    );
  };

  return {
    data: value,
    fetchedAt: (key: QueryKey): number | undefined => slot(key)[0]()?.fetchedAt,
    /** Change what a query last answered — after an action the server
     * confirmed — without reading it again. */
    update: <K extends QueryKey>(key: K, change: (current: R[K]) => R[K]) => {
      const [current, set] = slot(key);
      const held = current();
      const was = value(key);

      if (held && was !== undefined) set({ value: change(was), fetchedAt: held.fetchedAt });
    },
    busy: (tab: OpsTab) => TAB_QUERIES[tab].some((key) => busy().has(key)),
    error: (tab: OpsTab) => errors()[tab],
    /** The oldest read on this tab, for "Updated"; `undefined` until every
     * query it shows has answered at least once. */
    updatedAt: (tab: OpsTab): number | undefined => {
      const times = TAB_QUERIES[tab].map((key) => slot(key)[0]()?.fetchedAt);

      return times.every((t): t is number => t !== undefined) ? Math.min(...times) : undefined;
    },
    tabRemaining: (tab: OpsTab, now: number) => cooldowns[tab].remaining(now),
    allRemaining: (now: number) => all.remaining(now),
    /**
     * Arriving on `tab`. Reads only what it shows and does not yet have —
     * once per tab, so coming back to it reads nothing. The tab's cooldown
     * starts only if a read actually begins.
     */
    open: (tab: OpsTab, now: number) => {
      if (opened.has(tab)) return;
      opened.add(tab);
      const missing = TAB_QUERIES[tab].filter((key) => !slot(key)[0]() && !inflight.has(key));

      if (!missing.length) return;
      cooldowns[tab].start(now);
      void run(missing, "initial", tab, now);
    },
    refreshTab: (tab: OpsTab, now: number) => {
      const remaining = cooldowns[tab].remaining(now);

      if (remaining > 0) {
        blocked("tab", tab, remaining);

        return;
      }

      cooldowns[tab].start(now);
      void run(TAB_QUERIES[tab], "tab", tab, now);
    },
    refreshAll: (tab: OpsTab, now: number) => {
      const remaining = all.remaining(now);

      if (remaining > 0) {
        blocked("all", tab, remaining);

        return;
      }

      all.start(now);

      for (const other of OPS_TABS) {
        cooldowns[other].start(now);
        opened.add(other);
      }

      void run([...keys], "all", tab, now);
    },
    /** Forget everything: the session changed, so nothing read under the
     * old one may show under the new one. */
    reset: () => {
      for (const key of keys) slot(key)[1](undefined);
      setErrors({});
      opened.clear();
    },
  };
}
