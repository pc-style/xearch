import { describe, expect, it } from "vitest";
import {
  accountState,
  attentionItems,
  type AttentionInput,
  coverage,
  jobState,
  jobTarget,
  needsHistory,
  queueInfo,
  searchableTotal,
  throttledUntil,
  workerState,
} from "../src/ops/model";
import { account, DAY, emptyTimeline, HOUR, job, jobId, liveWorker, MINUTE } from "./opsFixtures";

const now = Date.now();

const attentionInput: AttentionInput = {
  now,
  jobs: [],
  accounts: [],
  summary: undefined,
  health: undefined,
  limit: undefined,
  config: undefined,
};

describe("account status", () => {
  it("reads a running first import, a failed import, indexing and staleness in that order", () => {
    const running = account(1, {
      lastCompletedAt: undefined,
      latestRun: { ...account(1).latestRun!, status: "running" },
    });

    expect(accountState(running, now)).toEqual({ s: "run", t: "First import running" });

    const failed = account(2, { latestRun: { ...account(2).latestRun!, status: "failed" } });

    expect(accountState(failed, now).t).toBe("Last import failed");

    const indexing = account(3, {
      publication: { state: "indexing", updatedAt: now },
    });

    expect(accountState(indexing, now).t).toBe("Indexing new posts");

    const old = now - 9 * DAY;

    const stale = account(4, {
      lastCompletedAt: old,
      publication: {
        state: "searchable",
        searchablePostCount: 5,
        lastPublishedAt: old,
        updatedAt: old,
      },
    });

    expect(accountState(stale, now)).toEqual({ s: "warn", t: "Stale · 9 d" });
    expect(accountState(account(5), now)).toEqual({ s: "ok", t: "Up to date" });

    const neverRun = account(6, {
      publication: null,
      latestRun: undefined,
      lastCompletedAt: undefined,
    });

    expect(accountState(neverRun, now)).toEqual({ s: "wait", t: "Nothing collected yet" });
    expect(accountState({ ...neverRun, latestRun: account(6).latestRun }, now).t).toBe(
      "Awaiting indexing",
    );
  });

  it("counts missing history only on evidence: an unfinished backfill or x.md's floor", () => {
    expect(needsHistory(account(1))).toBe(false);
    expect(
      needsHistory(
        account(2, { backfill: { status: "running", cursorUntil: "2019-01-01", postsFound: 1 } }),
      ),
    ).toBe(true);
    expect(
      needsHistory(
        account(3, { backfill: { status: "complete", cursorUntil: "2009-01-01", postsFound: 9 } }),
      ),
    ).toBe(false);
    expect(
      needsHistory(account(4, { latestRun: { ...account(4).latestRun!, floorReached: true } })),
    ).toBe(true);
  });
});

describe("totals", () => {
  it("sums searchable posts, and says unknown when a searchable account has no count", () => {
    expect(searchableTotal([account(1), account(2)])).toEqual({
      kind: "known",
      posts: 300,
      accounts: 2,
      total: 2,
    });

    const uncounted = account(3, { publication: { state: "searchable", updatedAt: now } });

    expect(searchableTotal([account(1), uncounted]).kind).toBe("unknown");
  });

  it("splits coverage into complete, missing history, missing recent, and nothing yet", () => {
    const old = now - 30 * DAY;

    expect(
      coverage(
        [
          account(1),
          account(2, { backfill: { status: "queued", cursorUntil: "2020-01-01", postsFound: 0 } }),
          account(3, {
            lastCompletedAt: old,
            publication: {
              state: "searchable",
              searchablePostCount: 1,
              lastPublishedAt: old,
              updatedAt: old,
            },
          }),
          account(4, { publication: null }),
          account(5, { latestRun: undefined, lastCompletedAt: undefined }),
        ],
        now,
      ),
    ).toEqual({ total: 5, complete: 1, history: 1, newer: 1, none: 1, unrecorded: 1 });
  });

  it("does not treat a recent indexer publication as newly collected posts", () => {
    const importedLongAgo = account(1, {
      lastCompletedAt: now - 30 * DAY,
      publication: {
        state: "searchable",
        searchablePostCount: 5,
        lastPublishedAt: now - DAY,
        updatedAt: now - DAY,
      },
    });

    expect(accountState(importedLongAgo, now)).toEqual({ s: "warn", t: "Stale · 30 d" });

    const item = attentionItems({ ...attentionInput, accounts: [importedLongAgo] }).find((i) =>
      i.key.startsWith("stale-"),
    );

    expect(item?.detail).toContain("Nothing newer than");
    expect(item?.detail).toContain("has been collected");
  });

  it("words a publication time as one when no import is on record", () => {
    const unrecorded = account(1, {
      latestRun: undefined,
      lastCompletedAt: undefined,
      publication: {
        state: "searchable",
        searchablePostCount: 5,
        lastPublishedAt: now - 30 * DAY,
        updatedAt: now - 30 * DAY,
      },
    });

    const item = attentionItems({ ...attentionInput, accounts: [unrecorded] }).find((i) =>
      i.key.startsWith("stale-"),
    );

    expect(item?.detail).toContain("the indexer last published it");
    expect(item?.detail).not.toContain("has been collected");
  });

  it("does not call a searchable account with no indexer count empty", () => {
    const uncounted = account(1, { publication: { state: "searchable", updatedAt: now } });

    expect(coverage([uncounted], now).none).toBe(0);
  });
});

describe("jobs", () => {
  it("calls a running job stalled after ten minutes without progress", () => {
    expect(jobState(job(1, { status: "running", updatedAt: now - 9 * MINUTE }), now)).toBe(
      "running",
    );
    expect(jobState(job(1, { status: "running", updatedAt: now - 11 * MINUTE }), now)).toBe(
      "stalled",
    );
    expect(jobState(job(1, { status: "partial" }), now)).toBe("failed");
  });

  it("labels a deep-history window by its account and dates", () => {
    expect(
      jobTarget(
        job(1, {
          kind: "live",
          origin: "history",
          input: "from:nvidia since:2018-01-01 until:2019-02-03",
          since: "2018-01-01",
          until: "2019-02-03",
        }),
      ),
    ).toEqual({ main: "@nvidia", sub: "older history 2018-01 → 2019-02" });
  });

  it("gives a finish time only when it comes from measured imports", () => {
    const entry = {
      jobId: jobId(1),
      kind: "bulk" as const,
      input: "a",
      status: "queued" as const,
      createdAt: now,
      waitReason: { kind: "ready" as const },
      estimate: { start: now, finish: now + HOUR, measured: false },
    };

    const guessed = { ...emptyTimeline(), entries: [entry] };

    const measured = {
      ...guessed,
      entries: [{ ...entry, estimate: { ...entry.estimate, measured: true } }],
    };

    expect(queueInfo(guessed).get(jobId(1))).toEqual({ position: 1, finish: undefined });
    expect(queueInfo(measured).get(jobId(1))).toEqual({ position: 1, finish: now + HOUR });
    expect(queueInfo({ ...measured, truncated: true }).get(jobId(1))).toEqual({
      position: 1,
      finish: now + HOUR,
    });
    expect(queueInfo({ ...measured, queueTruncated: true }).size).toBe(0);
  });
});

describe("provider and worker", () => {
  it("reports a throttle only while x.md's own window is still open", () => {
    const limit = {
      kind: "throttled" as const,
      provider: "xmd" as const,
      operation: "history",
      reason: "429",
      remaining: { kind: "unknown" as const },
      nextRetryAt: now + MINUTE,
      observedAt: now,
    };

    expect(throttledUntil(limit, now)).toBe(now + MINUTE);
    expect(throttledUntil(limit, now + 2 * MINUTE)).toBeUndefined();
    expect(throttledUntil({ kind: "none", provider: "xmd" }, now)).toBeUndefined();
  });

  it("reads the worker offline after 45 seconds of silence", () => {
    const config = {
      ...liveWorker(),
      handoffState: { kind: "live" as const, lastSeenAt: now - 44_000 },
    };

    expect(workerState(config, now)).toEqual({ kind: "online" });
    expect(workerState(config, now + 2_000)).toEqual({ kind: "offline", lastSeenAt: now - 44_000 });
  });
});
