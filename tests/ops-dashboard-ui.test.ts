// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(text(ops)).toMatch(/Updated \d\d:\d\d/);
    expect(text(ops)).not.toContain("auto-refresh");
    expect(ops.find(".pgd").textContent).toContain("Queued, running, stalled and failed work");
  });

  it("Search posts goes back to search", async () => {
    const ops = await open("overview");

    ops.click(".who button", "Search posts");
    expect(ops.openSearch).toEqual([""]);
  });
});

/** The finite reads made so far, by function name, in order. */
const names = (ops: MountedOps) => ops.reads.map((r) => r.name);

describe("reading by hand", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads only what the open tab shows, once, and subscribes to nothing but identity", async () => {
    const ops = await open("jobs");

    expect(names(ops).sort()).toEqual(["jobs:list", "queue:timelineSnapshot"]);
    expect(ops.subscribed).toEqual(["auth:me"]);

    // Time passing, the page being hidden and shown again, a re-render:
    // none of it reads anything.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await ops.settle();
    ops.html();

    expect(names(ops)).toHaveLength(2);
    expect(ops.subscribed).toEqual(["auth:me"]);
  });

  it("passes the instant of the read as now, not a ticking clock", async () => {
    const ops = await open("jobs");
    const read = ops.reads.find((r) => r.name === "queue:timelineSnapshot")!;

    expect(read.args.now).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await ops.settle();
    expect(ops.reads.filter((r) => r.name === "queue:timelineSnapshot")).toHaveLength(1);
  });

  it("a new tab reads only what it lacks; a tab seen before reads nothing", async () => {
    const ops = await open("accounts");

    expect(names(ops).sort()).toEqual(["ops:accountsSnapshot", "summary:summarySnapshot"]);

    await ops.show("overview");
    expect(names(ops).slice(2).sort()).toEqual([
      "integrations:operator",
      "jobs:list",
      "limits:current",
      "summary:healthSnapshot",
    ]);

    await ops.show("accounts");
    await ops.show("overview");
    expect(names(ops)).toHaveLength(6);
  });

  it("Refresh re-reads the current tab only, then waits 30 seconds", async () => {
    const ops = await open("accounts");
    const before = names(ops).length;

    // Arriving started the tab's cooldown: the button is not yet usable.
    ops.click("button[aria-label='Refresh Accounts']");
    await ops.settle();
    expect(names(ops)).toHaveLength(before);
    expect(ops.find(".toast").textContent).toMatch(/Refresh Accounts again in \d+ s/);

    await vi.advanceTimersByTimeAsync(31_000);
    ops.click("button[aria-label='Refresh Accounts']");
    await ops.settle();
    expect(names(ops).slice(before).sort()).toEqual([
      "ops:accountsSnapshot",
      "summary:summarySnapshot",
    ]);

    // A second click straight after is blocked; the reads stay as they were.
    ops.click("button[aria-label='Refresh Accounts']");
    await ops.settle();
    expect(names(ops)).toHaveLength(before + 2);
  });

  it("Refresh all re-reads every tab and waits five minutes, starting each tab's own wait", async () => {
    const ops = await open("provider");
    const before = names(ops).length;

    await vi.advanceTimersByTimeAsync(31_000);
    ops.click("button[aria-label='More refresh options']");
    ops.click(".opsnav .menu button", "Refresh all");
    await ops.settle();

    expect(names(ops).slice(before).sort()).toEqual([
      "integrations:operator",
      "jobs:list",
      "limits:current",
      "ops:accountsSnapshot",
      "ops:activitySnapshot",
      "queue:timelineSnapshot",
      "summary:healthSnapshot",
      "summary:summarySnapshot",
    ]);

    // Every tab is now loaded, so moving around reads nothing …
    await ops.show("overview");
    await ops.show("jobs");
    expect(names(ops)).toHaveLength(before + 8);

    // … and each tab's own 30-second wait was started by Refresh all.
    ops.click("button[aria-label='Refresh Jobs']");
    await ops.settle();
    expect(names(ops)).toHaveLength(before + 8);

    await vi.advanceTimersByTimeAsync(31_000);
    ops.click("button[aria-label='Refresh Jobs']");
    await ops.settle();
    expect(names(ops)).toHaveLength(before + 10);

    // Refresh all itself waits five minutes.
    ops.click("button[aria-label='More refresh options']");
    ops.click(".opsnav .menu button", "Refresh all");
    await ops.settle();
    expect(names(ops)).toHaveLength(before + 10);
    expect(ops.find(".toast").textContent).toMatch(/Refresh all again in \d+ s/);
  });

  it("keeps the last data and says what failed when a refresh fails", async () => {
    let fail = false;

    const ops = await open(
      "accounts",
      { accounts: [account(1, { handle: "bob", name: "Bob" })] },
      {
        fetch: (name) =>
          fail && name === "ops:accountsSnapshot"
            ? Promise.reject(new Error("Too many bytes read"))
            : undefined,
      },
    );

    expect(ops.find("tr[data-account=bob]")).toBeTruthy();
    fail = true;
    await vi.advanceTimersByTimeAsync(31_000);
    ops.click("button[aria-label='Refresh Accounts']");
    await ops.settle();

    expect(ops.find("tr[data-account=bob]")).toBeTruthy();
    expect(ops.find(".ops-error").textContent).toContain("Too many bytes read");
    expect(ops.find(".toast").textContent).toContain("Too many bytes read");
  });

  it("keeps the attention cards and pipeline stages in place across a refresh", async () => {
    // A refresh rebuilds the lists behind these cards. Recreating their DOM
    // replays the entry animation, which looks like the dashboard flashing.
    const ops = await open("overview", {
      jobs: [job(1, { input: "bob", status: "failed", error: "x.md 502 Bad Gateway" })],
      accounts: [account(1, { handle: "bob", name: "Bob" })],
    });

    const card = ops.find(".ai", "Import of @bob failed");
    const stage = ops.find(".st", "Queued");
    const before = names(ops).length;

    await vi.advanceTimersByTimeAsync(31_000);
    ops.click("button[aria-label='Refresh Overview']");
    await ops.settle();
    expect(names(ops).length).toBeGreaterThan(before);

    expect(ops.find(".ai", "Import of @bob failed")).toBe(card);
    expect(ops.find(".st", "Queued")).toBe(stage);
    expect(card.isConnected).toBe(true);
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

  it("says unknown, not 0, for a count the indexer has not reported in any state", async () => {
    const indexing = account(5, {
      handle: "indexing",
      publication: { state: "indexing", updatedAt: Date.now() },
    });

    const none = account(6, { handle: "none", publication: null });
    const ops = await open("accounts", { accounts: [indexing, none] });

    for (const handle of ["indexing", "none"])
      expect(ops.find(`tr[data-account='${handle}']`).querySelector("td.num")?.textContent).toBe(
        "unknown",
      );
  });

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
  it("retries every eligible failed job and leaves permanent failures alone", async () => {
    const ops = await open("jobs", {
      jobs: [
        job(1, {
          kind: "bulk",
          status: "failed",
          retryable: false,
          error: "x.md could not finish this request (404, not_found).",
        }),
        job(2, { kind: "post", status: "failed", retryable: false, error: "x.md 404" }),
        job(3, {
          kind: "bulk",
          status: "failed",
          retryable: false,
          error: "x.md stopped before completing the import.",
        }),
      ],
    });

    ops.click(".sh button", "Retry all failed");
    await ops.settle();

    expect(ops.calls).toEqual([
      { name: "jobs:retry", args: { jobId: jobId(1) } },
      { name: "jobs:retry", args: { jobId: jobId(3) } },
    ]);
    expect(ops.find(`tr[data-job=${jobId(1)}]`).textContent).toContain("Waiting");
    expect(ops.find(`tr[data-job=${jobId(3)}]`).textContent).toContain("Waiting");
    expect(ops.find(`tr[data-job=${jobId(2)}]`).textContent).toContain("x.md 404");
  });

  it("keeps retrying later failed jobs when one retry is rejected", async () => {
    const ops = await open(
      "jobs",
      {
        jobs: [
          job(1, { status: "failed", error: "first" }),
          job(2, { status: "failed", error: "second" }),
          job(3, { status: "failed", error: "third" }),
        ],
      },
      {
        mutation: (name, args) =>
          name === "jobs:retry" && args.jobId === jobId(2)
            ? Promise.reject(new Error("Already active"))
            : Promise.resolve(null),
      },
    );

    ops.click(".sh button", "Retry all failed");
    await ops.settle();

    expect(ops.calls.map((call) => call.args.jobId)).toEqual([jobId(1), jobId(2), jobId(3)]);
    expect(ops.find(`tr[data-job=${jobId(1)}]`).textContent).toContain("Waiting");
    expect(ops.find(`tr[data-job=${jobId(2)}]`).textContent).toContain("second");
    expect(ops.find(`tr[data-job=${jobId(3)}]`).textContent).toContain("Waiting");
    expect(ops.find(".toast").textContent).toContain("2 retries queued; 1 failed: Already active");
  });
  it("measures a finished job's run time from its attempt, not from when it was queued", async () => {
    const now = Date.now();

    const ops = await open("jobs", {
      jobs: [
        // Queued four days ago, retried an hour ago, failed after 12 minutes.
        job(1, {
          status: "failed",
          error: "boom",
          _creationTime: now - 4 * DAY,
          attemptStartedAt: now - HOUR - 12 * MINUTE,
          updatedAt: now - HOUR,
        }),
        // From before attempts were stamped: no honest run time exists.
        job(2, {
          status: "failed",
          error: "boom",
          _creationTime: now - 4 * DAY,
          updatedAt: now - HOUR,
        }),
      ],
    });

    const row = (n: number) => ops.find(`tr[data-job=${jobId(n)}]`).textContent ?? "";

    expect(row(1)).toContain("ran 12 min");
    expect(row(1)).not.toContain("ran 4 d");
    expect(row(2)).toContain("1 h ago");
    expect(row(2)).not.toContain("ran ");
  });

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
    expect(row(2).textContent).toContain("estimate unavailable");
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

  it("dismisses every failed job at once", async () => {
    const ops = await open("jobs", {
      jobs: [
        job(1, { status: "failed", error: "a" }),
        job(2, { status: "partial", error: "b" }),
        job(3, { status: "running", updatedAt: Date.now() - MINUTE }),
      ],
    });

    expect(ops.find(".sh button", "Dismiss failed").hasAttribute("disabled")).toBe(false);
    ops.click(".seg button", "History");
    expect(ops.find(".sh button", "Dismiss failed").hasAttribute("disabled")).toBe(true);
    ops.click(".seg button", "Active");
    ops.click(".sh button", "Dismiss failed");
    ops.click(".md button", "Dismiss failed");
    await settle();

    expect(ops.calls).toEqual([
      { name: "jobs:dismiss", args: { jobId: jobId(1) } },
      { name: "jobs:dismiss", args: { jobId: jobId(2) } },
    ]);
  });
});

describe("rows after an action, without a re-read", () => {
  it("a retried job shows as queued and a cancelled one as cancelled", async () => {
    const now = Date.now();

    const ops = await open("jobs", {
      jobs: [
        job(1, { status: "failed", error: "boom" }),
        job(2, { status: "running", updatedAt: now - MINUTE, postsReceived: 5 }),
      ],
    });

    const before = ops.reads.length;
    ops.click(`tr[data-job=${jobId(1)}] button`, "Retry");
    await ops.settle();
    expect(ops.find(`tr[data-job=${jobId(1)}]`).textContent).toContain("Waiting");
    expect(ops.find(`tr[data-job=${jobId(1)}]`).textContent).not.toContain("boom");

    ops.click(`tr[data-job=${jobId(2)}] button`, "Cancel");
    ops.click(".md button", "Cancel job");
    await ops.settle();
    ops.click(".seg button", "History");
    expect(ops.find(`tr[data-job=${jobId(2)}]`).textContent).toContain("Cancelled");
    expect(ops.reads).toHaveLength(before);
  });

  it("dismissing failed jobs removes each confirmed row, and stops at the first failure", async () => {
    const ops = await open(
      "jobs",
      {
        jobs: [
          job(1, { status: "failed", error: "a" }),
          job(2, { status: "failed", error: "b" }),
          job(3, { status: "failed", error: "c" }),
        ],
      },
      {
        mutation: (name, args) =>
          name === "jobs:dismiss" && args.jobId === jobId(2)
            ? Promise.reject(new Error("Stop this run before dismissing it."))
            : Promise.resolve(null),
      },
    );

    const before = ops.reads.length;
    ops.click(".sh button", "Dismiss failed");
    ops.click(".md button", "Dismiss failed");
    await ops.settle();

    const rows = () => {
      ops.html();

      return [...ops.container.querySelectorAll("tr[data-job]")].map((r) =>
        r.getAttribute("data-job"),
      );
    };

    // Job 1 was dismissed and is gone; 2 failed so it and 3 stay, in order.
    expect(rows()).toEqual([jobId(2), jobId(3)]);
    expect(ops.calls.map((c) => c.args.jobId)).toEqual([jobId(1), jobId(2)]);
    expect(ops.find(".toast").textContent).toContain("Stop this run before dismissing it.");
    expect(ops.reads).toHaveLength(before);
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

  it("shows 0 calls left when x.md is exhausted", async () => {
    const now = Date.now();

    const ops = await open("provider", {
      limit: {
        kind: "throttled",
        provider: "xmd",
        operation: "history",
        reason: "x.md rate limit reached: 429 from /v2/history.",
        remaining: { kind: "known", value: 0 },
        nextRetryAt: now + 30_000,
        observedAt: now,
      },
    });

    expect(ops.find(".pc", "Rate limit").textContent).toContain("0 calls left");
  });

  it("does not present an expired allowance as calls left now", async () => {
    const now = Date.now();

    const ops = await open("provider", {
      limit: {
        kind: "throttled",
        provider: "xmd",
        operation: "history",
        reason: "x.md rate limit reached.",
        remaining: { kind: "known", value: 0 },
        nextRetryAt: now - 30_000,
        observedAt: now - MINUTE,
      },
    });

    const card = ops.find(".pc", "Rate limit").textContent;

    expect(card).toContain("Available");
    expect(card).toContain("that window has passed");
    expect(card).not.toContain("0 calls left");
  });
});
