// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Value } from "convex/values";
import App from "../src/App";
import { COOLDOWN_STORAGE_PREFIX } from "../src/library/cooldown";
import { fakeConvex, mount, settle, type Mounted } from "./solid";

/**
 * The search app's bootstrap (`integrations.configured`) used to be a live
 * query asked every five seconds with a ticking clock, so every open page
 * re-ran it on a timer and on every write it touched. It is now read once
 * on load and again only from the header's Refresh, which waits 30 seconds
 * between reads (src/data/publicRefresh.ts).
 */
let mounted: Mounted | null = null;

const CONFIGURED: Value = {
  indexing: true,
  search: true,
  firecrawl: false,
  openai: false,
  email: false,
};

function open() {
  window.history.replaceState(null, "", "/?search=1");

  const convex = fakeConvex({
    query: (name) => (name === "search:accounts" ? [] : undefined),
    fetch: (name) => Promise.resolve(name === "integrations:configured" ? CONFIGURED : undefined),
  });

  mounted = mount(App, {}, convex);

  return convex;
}

async function settled() {
  for (let i = 0; i < 4; i++) await settle();
}

const bootstraps = (convex: ReturnType<typeof fakeConvex>) =>
  convex.fetched.filter((r) => r.name === "integrations:configured");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });

  for (const key of Object.keys(localStorage))
    if (key.startsWith(COOLDOWN_STORAGE_PREFIX)) localStorage.removeItem(key);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe("the search app's own refresh", () => {
  it("reads the bootstrap once, with the instant of the read, and never on a timer", async () => {
    const convex = open();
    await settled();

    expect(bootstraps(convex)).toHaveLength(1);
    expect(bootstraps(convex)[0].args.now).toBe(Date.now());
    expect(convex.subscribed).not.toContain("integrations:configured");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settled();
    expect(bootstraps(convex)).toHaveLength(1);
  });

  it("Refresh re-reads it, and waits 30 seconds between reads", async () => {
    const convex = open();
    await settled();

    const button = () => {
      mounted!.html();

      return mounted!.container.querySelector<HTMLButtonElement>("button[aria-label='Refresh']")!;
    };

    // Loading the page started the wait.
    button().click();
    await settled();
    expect(bootstraps(convex)).toHaveLength(1);
    expect(mounted!.html()).toMatch(/Refresh again in \d+ s\./);

    await vi.advanceTimersByTimeAsync(31_000);
    button().click();
    await settled();
    expect(bootstraps(convex)).toHaveLength(2);
    expect(bootstraps(convex)[1].args.now).toBe(Date.now());

    button().click();
    await settled();
    expect(bootstraps(convex)).toHaveLength(2);
  });
});
