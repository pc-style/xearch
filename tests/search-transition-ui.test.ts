// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Value } from "convex/values";
import App from "../src/App";
import { fakeConvex, mount, settle, type Mounted } from "./solid";

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  Reflect.deleteProperty(document, "startViewTransition");
  vi.restoreAllMocks();
});

describe("search view transitions", () => {
  it("keeps a completed search when the browser delays the view update", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?search=1&q=%40cohere");
    const sessions = new Map<string, Value>();
    const started: string[] = [];

    const convex = fakeConvex({
      query: (name, args) => {
        if (name === "integrations:configured")
          return { indexing: true, search: true, firecrawl: false, openai: false, email: false };

        if (name === "search:accounts") return [];

        if (name === "search:results") return sessions.get(String(args.sessionId));

        return undefined;
      },
      mutation: async (name, args) => {
        if (name !== "search:start") return null;
        const id = `session-${started.length + 1}`;
        const raw = String(args.raw);
        started.push(raw);
        sessions.set(id, {
          _id: id,
          _creationTime: Date.now(),
          owner: "user-1",
          raw,
          sort: args.sort,
          includeStats: false,
          status: "complete",
          rows: [],
          warnings: [],
        });

        return id;
      },
    });

    mounted = mount(App, {}, convex);
    await vi.waitFor(() => {
      mounted?.html();
      expect(started).toHaveLength(1);
      expect(mounted?.html()).not.toContain("Finding matching posts…");
    });

    let update: (() => void) | undefined;
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: (callback: () => void) => {
        update = callback;
        const done = Promise.resolve();

        return { updateCallbackDone: done, ready: done, finished: done };
      },
    });

    const input = mounted.container.querySelector<HTMLInputElement>("#query")!;
    input.value = "local-first software";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    mounted.container.querySelector<HTMLFormElement>("#form")!.requestSubmit();
    await settle();

    expect(update).toBeDefined();
    expect(started).toEqual(["@cohere"]);
    update!();
    await settle();

    expect(started).toEqual(["@cohere", "local-first software"]);
    expect(mounted.html()).toContain("No matches in the indexed accounts yet.");
    expect(mounted.html()).not.toContain("Finding matching posts…");
  });
});
