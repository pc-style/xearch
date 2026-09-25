// A mount helper for the /ops dashboard tests. The dashboard reads
// everything through src/data/convex, so it renders under the fake Convex
// app from tests/solid.ts, answering each finite read by function name.
import { createSignal, flush } from "solid-js";
import { z } from "zod";
import type { Value } from "convex/values";
import type { Doc } from "../convex/_generated/dataModel";
import type { DashboardSummary } from "../convex/lib/contracts";
import type { OpsAccount, OpsActivity } from "../convex/ops";
import type { ProviderLimit } from "../convex/limits";
import type { ServiceStatus } from "../convex/summary";
import type { Timeline } from "../convex/queue";
import type { OpsTab } from "../src/locationStore";
import type { OperatorConfig } from "../src/ops/model";
import Ops from "../src/ops/Ops";
import { canRetry } from "../src/ops/model";
import { COOLDOWN_STORAGE_PREFIX } from "../src/library/cooldown";
import { activity, emptyTimeline, healthy, liveWorker, summary } from "./opsFixtures";
import { fakeConvex, mount, settle, type Mounted } from "./solid";

export * from "./opsFixtures";

export type OpsFixtures = {
  accounts?: OpsAccount[];
  jobs?: Doc<"jobs">[];
  summary?: DashboardSummary;
  activity?: OpsActivity;
  health?: ServiceStatus[];
  limit?: ProviderLimit;
  config?: OperatorConfig;
  timeline?: Timeline;
  me?: { id: string; isAnonymous: boolean; email?: string; emailVerified: boolean } | null;
};

export type Call = { name: string; args: Record<string, Value> };

export type MountedOps = Mounted & {
  calls: Call[];
  /** Every finite read the dashboard made, with its arguments, in order. */
  reads: Call[];
  /** Every live subscription it opened (by function name). */
  subscribed: string[];
  openSearch: string[];
  /** Move to another tab, as the address bar would, and let it load. */
  show(tab: OpsTab): Promise<void>;
  /** Let every pending read land and render. */
  settle(): Promise<void>;
  click(selector: string, text?: string): void;
  find(selector: string, text?: string): HTMLElement;
  type(selector: string, value: string): void;
};

export type MountOptions = {
  /** Answer a read yourself (a failure, a delay); anything else comes from
   * the fixtures. Return `undefined` to fall through. */
  fetch?: (name: string, args: Record<string, Value>) => Promise<Value> | undefined;
  mutation?: (name: string, args: Record<string, Value>) => Promise<Value>;
};

/** A read chain has a few more microtask hops than one flush covers. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle();
}

/** Forget the cooldowns an earlier test left in this window's storage. */
export function clearCooldowns(): void {
  for (const key of Object.keys(localStorage))
    if (key.startsWith(COOLDOWN_STORAGE_PREFIX)) localStorage.removeItem(key);
}

/** Everything the dashboard reads, answered from `fixtures` with honest
 * empty defaults. Mutations are recorded in `calls`. */
export async function mountOps(
  initialTab: OpsTab,
  fixtures: OpsFixtures = {},
  options: MountOptions = {},
): Promise<MountedOps> {
  clearCooldowns();

  const answers = {
    "auth:me": fixtures.me ?? { id: "user1", isAnonymous: true, emailVerified: false },
    "ops:accountsSnapshot": { rows: fixtures.accounts ?? [], truncated: false },
    "ops:activitySnapshot": fixtures.activity ?? activity(),
    "summary:summarySnapshot": fixtures.summary ?? summary(),
    "summary:healthSnapshot": fixtures.health ?? healthy(),
    "limits:current": fixtures.limit ?? { kind: "none", provider: "xmd" },
    "integrations:operator": fixtures.config ?? liveWorker(),
    "queue:timelineSnapshot": fixtures.timeline ?? emptyTimeline(),
    "jobs:list": { jobs: fixtures.jobs ?? [], truncated: false },
  };

  // SAFETY: every fixture is built from its query's own return type, which
  // the query's validator guarantees is a plain Convex value.
  const toValue = (fixture: (typeof answers)[keyof typeof answers]) => fixture as Value;

  const isAnswered = (name: string): name is keyof typeof answers => Object.hasOwn(answers, name);

  const calls: Call[] = [];
  const openSearch: string[] = [];
  const answer = (name: string) => (isAnswered(name) ? toValue(answers[name]) : undefined);

  const convex = fakeConvex({
    // Identity is the dashboard's one live read (src/ops/Ops.tsx).
    query: answer,
    fetch: (name, args) => {
      const custom = options.fetch?.(name, args);

      if (custom !== undefined) return custom;

      if (name === "jobs:failedForRetry") {
        const status = args.status;

        const pagination = z
          .object({ cursor: z.string().nullable() })
          .safeParse(args.paginationOpts);

        const start = Number(pagination.success ? (pagination.data.cursor ?? 0) : 0);

        const eligible = (fixtures.jobs ?? []).filter(
          (job) => job.status === status && job.dismissedAt === undefined && canRetry(job),
        );

        const page = eligible.slice(start, start + 100);
        const next = start + page.length;

        return Promise.resolve({
          jobIds: page.map((job) => job._id),
          cursor: String(next),
          done: next >= eligible.length,
        });
      }

      return Promise.resolve(answer(name));
    },
    mutation: (name, args) => {
      calls.push({ name, args });

      return options.mutation ? options.mutation(name, args) : Promise.resolve(null);
    },
  });

  const [tab, setTab] = createSignal(initialTab);

  const mounted = mount(
    Ops,
    {
      get tab() {
        return tab();
      },
      ensureSession: () => Promise.resolve(),
      openSearch: (query?: string) => {
        openSearch.push(query ?? "");
      },
    },
    convex,
  );

  await settled();

  const find = (selector: string, text?: string) => {
    mounted.html();

    const match = [...mounted.container.querySelectorAll<HTMLElement>(selector)].find(
      (el) => text === undefined || el.textContent?.includes(text),
    );

    if (!match) throw new Error(`nothing matches ${selector}${text ? ` with "${text}"` : ""}`);

    return match;
  };

  return {
    ...mounted,
    calls,
    reads: convex.fetched,
    subscribed: convex.subscribed,
    openSearch,
    show: async (next) => {
      setTab(next);
      flush();
      await settled();
    },
    settle: settled,
    find,
    click: (selector, text) => find(selector, text).click(),
    type: (selector, value) => {
      const input = find(selector);

      if (!(input instanceof HTMLInputElement)) throw new Error(`${selector} is not an input`);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
  };
}
