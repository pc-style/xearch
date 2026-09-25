import { describe, expect, it } from "vitest";
import { createDashboardStore, type QueryKey } from "../src/ops/refresh";

/** A read that answers only when the test lets it. */
function deferredReads() {
  const pending: { key: QueryKey; resolve: (value: string) => void }[] = [];

  const read = <K extends QueryKey>(key: K) =>
    new Promise<string>((resolve) => {
      pending.push({ key, resolve });
    });

  return { pending, read };
}

type Answers = Record<QueryKey, string>;

const memory = () => {
  const store = new Map<string, string>();

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
};

describe("createDashboardStore", () => {
  it("drops a read begun under a session that was reset before it landed", async () => {
    const { pending, read } = deferredReads();
    const said: string[] = [];

    const store = createDashboardStore<Answers>({
      read,
      say: (m) => said.push(m),
      storage: memory(),
    });

    store.open("jobs", 1_000);
    expect(pending.map((p) => p.key).sort()).toEqual(["jobs", "timeline"]);

    // The session goes away while the reads are still out.
    store.reset();
    const old = pending.splice(0);

    // The next session opens the same tab: it must read again, not wait on
    // the old reads or reuse their answers.
    store.open("jobs", 2_000);
    expect(pending.map((p) => p.key).sort()).toEqual(["jobs", "timeline"]);

    for (const p of old) p.resolve(`old ${p.key}`);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.data("jobs")).toBeUndefined();
    expect(store.busy("jobs")).toBe(true);

    for (const p of pending) p.resolve(`new ${p.key}`);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.data("jobs")).toBe("new jobs");
    expect(store.data("timeline")).toBe("new timeline");
    expect(store.busy("jobs")).toBe(false);
    expect(said).toEqual([]);
  });
});
