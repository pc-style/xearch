// A mount helper for the /ops dashboard tests. The dashboard reads
// everything through src/data/convex, so it renders under the fake Convex
// app from tests/solid.ts, answering each query by function name.
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
  /** Every query read, with the arguments it was read with. */
  reads: Call[];
  openSearch: string[];
  click(selector: string, text?: string): void;
  find(selector: string, text?: string): HTMLElement;
  type(selector: string, value: string): void;
};

/** Everything the dashboard queries, answered from `fixtures` with honest
 * empty defaults. Mutations are recorded in `calls`. */
export async function mountOps(tab: OpsTab, fixtures: OpsFixtures = {}): Promise<MountedOps> {
  const answers = {
    "auth:me": fixtures.me ?? { id: "user1", isAnonymous: true, emailVerified: false },
    "ops:accounts": { rows: fixtures.accounts ?? [], truncated: false },
    "ops:activity": fixtures.activity ?? activity(),
    "summary:summary": fixtures.summary ?? summary(),
    "summary:health": fixtures.health ?? healthy(),
    "limits:current": fixtures.limit ?? { kind: "none", provider: "xmd" },
    "integrations:operator": fixtures.config ?? liveWorker(),
    "queue:timeline": fixtures.timeline ?? emptyTimeline(),
    "jobs:list": { jobs: fixtures.jobs ?? [], truncated: false },
  };

  // SAFETY: every fixture is built from its query's own return type, which
  // the query's validator guarantees is a plain Convex value.
  const toValue = (fixture: (typeof answers)[keyof typeof answers]) => fixture as Value;

  const isAnswered = (name: string): name is keyof typeof answers => Object.hasOwn(answers, name);

  const calls: Call[] = [];
  const reads: Call[] = [];
  const openSearch: string[] = [];

  const convex = fakeConvex({
    query: (name, args) => {
      reads.push({ name, args });

      return isAnswered(name) ? toValue(answers[name]) : undefined;
    },
    mutation: (name, args) => {
      calls.push({ name, args });

      return Promise.resolve(null);
    },
  });

  const mounted = mount(
    Ops,
    {
      tab,
      ensureSession: () => Promise.resolve(),
      openSearch: (query?: string) => {
        openSearch.push(query ?? "");
      },
    },
    convex,
  );

  await settle();

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
    reads,
    openSearch,
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
