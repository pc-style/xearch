// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { settle, stripMarkers } from "./solid";
import {
  account,
  activity,
  DAY,
  HOUR,
  job,
  jobId,
  liveWorker,
  MINUTE,
  mountOps,
  summary,
  type MountedOps,
} from "./opsHarness";

let mounted: MountedOps | null = null;

async function open(...args: Parameters<typeof mountOps>) {
  mounted = await mountOps(...args);

  return mounted;
}

const text = (ops: MountedOps) => stripMarkers(ops.html()).replace(/<[^>]+>/g, " ");

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("ops shell", () => {
  it("names the one identity the app knows, and invents no second operator", async () => {
    const ops = await open("overview", {
      me: { id: "u", isAnonymous: false, email: "adam@pcstyle.dev", emailVerified: true },
    });

    expect(text(ops)).toContain("signed in as adam@pcstyle.dev");
    expect(text(ops)).not.toMatch(/\d+ operators/);
    expect(ops.container.querySelectorAll(".who .ring")).toHaveLength(1);
  });

  it("says the operator key signed in when there is no verified email", async () => {
    const ops = await open("overview");

    expect(text(ops)).toContain("signed in with the operator key");
  });

  it("marks the current tab and links every tab to its own path", async () => {
    const ops = await open("jobs");
    const links = [...ops.container.querySelectorAll<HTMLAnchorElement>(".opsnav a")];

    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/ops",
      "/ops/accounts",
      "/ops/jobs",
      "/ops/imports",
      "/ops/performance",
      "/ops/provider",
    ]);
    expect(ops.find(".opsnav a.on").textContent).toBe("Jobs");
    expect(ops.find(".opsnav a.on").getAttribute("aria-current")).toBe("page");
    expect(text(ops)).toContain("auto-refresh 30 s");
    expect(ops.find(".pgd").textContent).toContain("Queued, running, stalled and failed work");
  });

  it("Public site goes back to search", async () => {
    const ops = await open("overview");

    ops.click(".who button", "Public site");
    expect(ops.openSearch).toEqual([""]);
  });

  it("Reload re-reads every clock-bound query with a new clock", async () => {
    const ops = await open("overview");

    const clocks = () => {
      ops.html();

      return ops.reads.filter((r) => r.name === "summary:summary").map((r) => Number(r.args.now));
    };

    const before = Math.max(...clocks());

    ops.click("button[aria-label='Reload data']");
    await vi.waitFor(() => expect(Math.max(...clocks())).toBeGreaterThan(before));

    const reloaded = Math.max(...clocks());

    ops.click("button[aria-label='Reload data']");
    await vi.waitFor(() => expect(Math.max(...clocks())).toBeGreaterThan(reloaded));
    expect(ops.find(".toast").textContent).toContain("Reloaded");
  });
});

describe("overview", () => {
  it("says nothing needs attention only when that is true", async () => {
    const ops = await open("overview", { accounts: [account(1)] });

    expect(text(ops)).toContain("Nothing needs you right now.");
  });

  it("lists a failed job with its real error and retries it through jobs.retry", async () => {
    const failed = job(1, {
      input: "bob",
      status: "failed",
      error: "x.md 502 Bad Gateway after 3 retries",
    });

    const ops = await open("overview", {
      jobs: [failed],
      accounts: [account(1, { handle: "bob", name: "Bob" })],
    });

    const item = ops.find(".ai", "Import of @bob failed");

    expect(item.dataset.s).toBe("crit");
    expect(item.textContent).toContain("x.md 502 Bad Gateway after 3 retries");
    expect(item.textContent).toContain("Existing 100 posts are still searchable.");

    ops.click(".ai button", "Retry");
    await settle();

    expect(ops.calls).toEqual([{ name: "jobs:retry", args: { jobId: jobId(1) } }]);
    expect(text(ops)).toContain("Retrying import of @bob");
  });

  it("offers no retry for a failure x.md said is permanent", async () => {
    const ops = await open("overview", {
      jobs: [job(1, { status: "failed", retryable: false, error: "not_found" })],
    });

    const item = ops.find(".ai", "failed");

    expect(item.textContent).not.toContain("Retry");
    expect(item.textContent).toContain("View error");
  });

  it("flags a stalled job and cancels it only after confirming", async () => {
    const now = Date.now();

    const ops = await open("overview", {
      jobs: [job(2, { status: "running", updatedAt: now - 34 * MINUTE, postsReceived: 2140 })],
    });

    const item = ops.find(".ai", "has made no progress for 34 min");

    expect(item.textContent).toContain("2,140 posts collected");
    ops.click(".ai button", "Cancel, keep posts");
    expect(ops.calls).toEqual([]);

    const dialog = ops.find(".md[role=dialog]");

    expect(dialog.textContent).toContain("Cancel import of @handle2?");
    ops.click(".md button", "Keep it");
    ops.html();
    expect(ops.container.querySelector(".md")).toBeNull();

    ops.click(".ai button", "Cancel, keep posts");
    ops.click(".md button", "Cancel job");
    await settle();

    expect(ops.calls).toEqual([{ name: "jobs:cancel", args: { jobId: jobId(2) } }]);
  });

  it("flags a stale account and refreshes it through jobs.start", async () => {
    const old = Date.now() - 13 * DAY;

    const ops = await open("overview", {
      accounts: [
        account(3, {
          handle: "MistralAI",
          name: "Mistral AI",
          lastCompletedAt: old,
          publication: {
            state: "searchable",
            searchablePostCount: 1140,
            lastPublishedAt: old,
            updatedAt: old,
          },
        }),
      ],
    });

    expect(ops.find(".ai", "@MistralAI last refreshed 13 days ago").dataset.s).toBe("warn");

    ops.click(".ai button", "Search posts");
    expect(ops.openSearch).toEqual(["@MistralAI"]);

    ops.click(".ai button", "Refresh now");
    await settle();

    expect(ops.calls).toEqual([
      { name: "jobs:start", args: { kind: "bulk", input: "MistralAI", refresh: true } },
    ]);
  });

  it("flags an offline worker and an active x.md rate limit", async () => {
    const now = Date.now();

    const ops = await open("overview", {
      config: { ...liveWorker(), handoffState: { kind: "live", lastSeenAt: now - 10 * MINUTE } },
      limit: {
        kind: "throttled",
        provider: "xmd",
        operation: "history",
        reason: "429",
        remaining: { kind: "known", value: 0 },
        resetAt: now + 9 * MINUTE,
        observedAt: now,
      },
    });

    expect(ops.find(".ai", "The download worker is offline").textContent).toContain(
      "Last seen 10 min ago",
    );
    ops.click(".ai button", "See provider usage");
    expect(window.location.pathname).toBe("/ops/provider");
  });

  it("shows the pipeline from real counts and labels the backlog in batches", async () => {
    const ops = await open("overview", {
      summary: summary({
        waitingDownloads: { kind: "known", unit: "jobs", value: 2 },
        activeDownloads: { kind: "known", unit: "jobs", value: 1 },
        savedCapturesAwaitingIndexing: { kind: "known", unit: "captures", value: 7 },
      }),
      accounts: [account(1), account(2, { publication: null, latestRun: undefined })],
    });

    const stages = [...ops.container.querySelectorAll(".st")].map((s) => s.textContent);

    expect(stages[0]).toContain("Queued2");
    expect(stages[1]).toContain("Running1");
    expect(stages[2]).toContain("Awaiting indexing7downloaded batches");
    expect(stages[3]).toContain("Searchable100posts across 1 of 2 accounts");
    expect(ops.find(".cov").textContent).toContain("Coverage across 2 accounts");
    expect(ops.find(".cov").textContent).toContain("1 nothing searchable yet");
  });

  it("shows an unknown count as a dash, never a zero", async () => {
    const ops = await open("overview", {
      summary: summary({ savedCapturesAwaitingIndexing: { kind: "unknown", unit: "captures" } }),
    });

    expect(ops.find(".st", "Awaiting indexing").querySelector("big")?.textContent).toBe("—");
  });
});

describe("performance", () => {
  it("renders health cards, the backlog, and the last day's charts", async () => {
    const act = activity({
      search: {
        queries: 12,
        failed: 1,
        timedSample: 4,
        medianMs: 38,
        p95Ms: 140,
        lastAt: Date.now(),
        truncated: false,
      },
    });

    act.downloads.hours[23] = { ...act.downloads.hours[23], posts: 51, other: 3 };

    const ops = await open("performance", {
      activity: act,
      accounts: [account(1)],
      summary: summary({
        savedCapturesAwaitingIndexing: { kind: "known", unit: "captures", value: 4 },
      }),
    });

    expect(ops.container.querySelectorAll(".hc")).toHaveLength(5);
    expect(ops.find(".hc", "Search").textContent).toContain("p95 140 ms");
    expect(ops.find(".hc", "Indexer").textContent).toContain("4 downloaded batches");
    expect(ops.find(".bl").textContent).toContain("indexing rate · not tracked yet");
    expect(ops.find(".chart", "Last 24 h").textContent).toContain("51 post records · 3 other");
    expect(ops.find(".chart", "Search").textContent).toContain("38 ms");
    expect(ops.find(".chart", "Search").textContent).toContain("from the 4 searches");
  });
});

describe("accounts", () => {
  const accounts = () => [
    account(1, { handle: "OpenAI", name: "OpenAI" }),
    account(2, {
      handle: "huggingface",
      name: "Hugging Face",
      latestRun: {
        jobId: jobId(5),
        status: "failed",
        createdAt: Date.now() - HOUR,
        updatedAt: Date.now() - HOUR,
        refresh: true,
        error: "502",
      },
    }),
    account(3, {
      handle: "nvidia",
      name: "NVIDIA",
      joined: "2009-01-01T00:00:00.000Z",
      backfill: { status: "running", cursorUntil: "2019-02-03", postsFound: 10 },
      oldestCollected: "2019-02-03",
    }),
  ];

  it("says unknown, not 0, for a searchable account the indexer has not counted", async () => {
    const uncounted = account(4, {
      handle: "uncounted",
      publication: { state: "searchable", updatedAt: Date.now() },
    });

    const ops = await open("accounts", { accounts: [uncounted] });
    const row = ops.find("tr[data-account='uncounted']");

    expect(row.querySelector("td.num")?.textContent).toBe("unknown");
    expect(
      row.querySelector<HTMLButtonElement>("button[aria-label='Search @uncounted’s posts']")
        ?.disabled,
    ).toBe(false);
  });

  it("filters by segment and by text", async () => {
    const ops = await open("accounts", { accounts: accounts() });

    const rows = () => {
      ops.html();

      return [...ops.container.querySelectorAll("tr[data-account]")].map((r) =>
        r.getAttribute("data-account"),
      );
    };

    expect(rows()).toEqual(["OpenAI", "huggingface", "nvidia"]);
    expect(ops.find(".seg button", "Failing").textContent).toBe("Failing1");

    ops.click(".seg button", "Failing");
    expect(rows()).toEqual(["huggingface"]);

    ops.click(".seg button", "Need more history");
    expect(rows()).toEqual(["nvidia"]);
    expect(ops.find("tr[data-account=nvidia]").textContent).toContain(
      "missing 1 Jan 2009 → 3 Feb 2019",
    );

    ops.click(".seg button", "All");
    ops.type(".tools input", "open");
    expect(rows()).toEqual(["OpenAI"]);
  });

  it("refreshes the selected accounts in bulk", async () => {
    const ops = await open("accounts", { accounts: accounts() });

    for (const handle of ["OpenAI", "nvidia"])
      ops.find(`tr[data-account=${handle}] input[type=checkbox]`).click();

    expect(ops.find(".bulk").textContent).toContain("2 selected");
    ops.click(".bulk button", "Refresh selected");

    await vi.waitFor(() =>
      expect(ops.find(".bulk").textContent).toContain("Select rows for bulk actions"),
    );
    expect(ops.calls.map((c) => c.args.input)).toEqual(["OpenAI", "nvidia"]);
  });

  it("opens the account import form from Import account", async () => {
    const ops = await open("accounts");

    ops.click(".sh button", "Import account");
    expect(window.location.pathname).toBe("/ops/imports");
  });
});

describe("jobs", () => {
  it("splits active from history and maps each state to its actions", async () => {
    const now = Date.now();

    const ops = await open("jobs", {
      jobs: [
        job(1, { status: "running", updatedAt: now - MINUTE, postsReceived: 1870 }),
        job(2, { status: "queued" }),
        job(3, { status: "failed", error: "boom" }),
        job(4, { status: "complete", count: 64, kind: "post", input: "https://x.com/a/status/1" }),
      ],
    });

    const row = (n: number) => ops.find(`tr[data-job=${jobId(n)}]`);

    expect(row(1).textContent).toContain("Running");
    expect(row(1).textContent).toContain("1,870 posts collected · total unknown");
    expect(row(1).textContent).toContain("estimate unavailable");
    expect(row(2).textContent).toContain("Remove");
    expect(row(3).textContent).toContain("boom");
    expect(ops.container.querySelector(`tr[data-job=${jobId(4)}]`)).toBeNull();

    ops.click(`tr[data-job=${jobId(3)}] button`, "Retry");
    await settle();
    expect(ops.calls).toEqual([{ name: "jobs:retry", args: { jobId: jobId(3) } }]);

    ops.click(".seg button", "History");
    expect(row(4).textContent).toContain("64 records kept");
    ops.click(`tr[data-job=${jobId(4)}] button`, "Run again");
    await settle();
    expect(ops.calls.at(-1)).toEqual({
      name: "jobs:start",
      args: { kind: "post", input: "https://x.com/a/status/1", refresh: false },
    });
  });

  it("clears finished runs after confirming", async () => {
    const ops = await open("jobs", {
      jobs: [job(1, { status: "complete" }), job(2, { status: "cancelled" })],
    });

    expect(ops.find(".sh button", "Clear finished").hasAttribute("disabled")).toBe(true);
    ops.click(".seg button", "History");
    ops.click(".sh button", "Clear finished");
    expect(ops.find(".md").textContent).toContain("Clear 2 finished runs?");
    ops.click(".md button", "Clear history");
    await settle();

    expect(ops.calls.map((c) => c.name)).toEqual(["jobs:dismiss", "jobs:dismiss"]);
  });
});

describe("other imports", () => {
  it("queues the chosen import through jobs.start", async () => {
    const ops = await open("imports");

    ops.click(".imports .list button", "X search results");
    ops.type("#ops-imp-in", "local-first");
    ops
      .find(".imports form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(ops.calls).toEqual([
      { name: "jobs:start", args: { kind: "live", input: "local-first" } },
    ]);
    expect(window.location.pathname).toBe("/ops/jobs");
  });

  it("says when the worker is offline instead of promising a start", async () => {
    const ops = await open("imports", {
      config: { ...liveWorker(), handoffState: { kind: "live", lastSeenAt: null } },
    });

    expect(ops.find(".costline").textContent).toContain("The download worker is offline");
  });
});

describe("provider", () => {
  it("shows x.md's own words and leaves untracked figures untracked", async () => {
    const now = Date.now();

    const ops = await open("provider", {
      limit: {
        kind: "throttled",
        provider: "xmd",
        operation: "history",
        reason: "x.md rate limit reached: 429 from /v2/history.",
        remaining: { kind: "known", value: 3 },
        nextRetryAt: now + 30_000,
        observedAt: now,
      },
      activity: activity({
        jobs: { byKind: [{ kind: "bulk", count: 5 }], failed: 2, truncated: false },
        throttles: { xmd: 11, truncated: false },
      }),
    });

    const page = text(ops);

    expect(page).toContain("x.md rate limit reached: 429 from /v2/history.");
    expect(page).toContain("3 calls left");
    expect(page).toContain("Hourly call budget");
    expect(page).toContain("not tracked yet");
    expect(ops.find(".pc", "Last 24 h").textContent).toContain("Account history5");
    expect(ops.find(".pc", "Errors").textContent).toContain("2 failed runs");
    expect(ops.find(".pc", "Errors").textContent).toContain("11");
  });
});
