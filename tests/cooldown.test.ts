import { describe, expect, it } from "vitest";
import { cooldownLabel, COOLDOWN_STORAGE_PREFIX, createCooldown } from "../src/library/cooldown";
import { needsFreshSession } from "../src/data/httpQuery";
import { ConvexError } from "convex/values";

/** A `localStorage` stand-in that outlives one `createCooldown`. */
function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    store,
  };
}

describe("createCooldown", () => {
  it("is over until started, then counts down from the start", () => {
    const cooldown = createCooldown("t", 30_000, memoryStorage());

    expect(cooldown.remaining(1_000)).toBe(0);
    cooldown.start(1_000);
    expect(cooldown.remaining(1_000)).toBe(30_000);
    expect(cooldown.remaining(20_000)).toBe(11_000);
    expect(cooldown.remaining(31_000)).toBe(0);
    expect(cooldown.remaining(99_000)).toBe(0);
  });

  it("survives a reload: a new instance reads the stored end", () => {
    const storage = memoryStorage();
    createCooldown("ops:jobs", 30_000, storage).start(5_000);

    expect(storage.store.get(`${COOLDOWN_STORAGE_PREFIX}ops:jobs`)).toBe("35000");
    expect(createCooldown("ops:jobs", 30_000, storage).remaining(10_000)).toBe(25_000);
  });

  it("treats a missing or damaged stored value as no cooldown", () => {
    expect(createCooldown("a", 1_000, memoryStorage()).until()).toBe(0);
    expect(
      createCooldown(
        "a",
        1_000,
        memoryStorage({ [`${COOLDOWN_STORAGE_PREFIX}a`]: "soon" }),
      ).until(),
    ).toBe(0);
    expect(createCooldown("a", 1_000, null).remaining(0)).toBe(0);
  });

  it("labels the remainder in whole seconds, rounded up", () => {
    expect(cooldownLabel(30_000)).toBe("30 s");
    expect(cooldownLabel(1)).toBe("1 s");
    expect(cooldownLabel(11_400)).toBe("12 s");
  });
});

describe("needsFreshSession", () => {
  it("retries only a read the session failed, never one the query failed", () => {
    expect(needsFreshSession(new Error("Unauthenticated"))).toBe(true);
    expect(needsFreshSession(new ConvexError("Start a session to use your workspace."))).toBe(true);
    expect(needsFreshSession(new ConvexError("Sign in as an operator to import."))).toBe(true);
    expect(needsFreshSession(new Error("Too many bytes read in a single function execution"))).toBe(
      false,
    );
    expect(needsFreshSession("nope")).toBe(false);
  });
});
