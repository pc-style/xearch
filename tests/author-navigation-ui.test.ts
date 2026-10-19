import { afterEach, expect, it, vi } from "vitest";
import type { Value } from "convex/values";
import App from "../src/App";
import { post } from "./fixtures/results";
import { fakeConvex, mount, settle, type Mounted } from "./solid";

let mounted: Mounted | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

it.each(["result", "wall"])(
  "browses an author from the %s after a semantic search",
  async (surface) => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?search=1&q=software&mode=semantic");
    const starts: Record<string, Value>[] = [];
    const sessions = new Map<string, Value>();

    const convex = fakeConvex({
      query: (name, args) => {
        if (name === "integrations:configured")
          return {
            indexing: true,
            search: true,
            semantic: true,
            firecrawl: false,
            openai: false,
            email: false,
          };

        if (name === "search:accounts")
          return [{ _id: "account-1", handle: "alice", status: "ready", tweetCount: 1 }];

        if (name === "wall:posts") return [];

        if (name === "search:resultsByKey") return sessions.get(String(args.clientKey)) ?? null;

        return undefined;
      },
      mutation: async (name, args) => {
        if (name !== "search:start") return null;
        starts.push(args);
        const id = `session-${starts.length}`;
        sessions.set(String(args.clientKey), {
          _id: id,
          _creationTime: Date.now(),
          owner: "user-1",
          raw: args.raw,
          clientKey: args.clientKey,
          sort: args.sort,
          mode: args.mode,
          includeStats: false,
          status: "complete",
          rows: [post({ author: "alice" })],
          warnings: [],
        });
        queueMicrotask(() => convex.changed("search:resultsByKey"));

        return id;
      },
    });

    mounted = mount(App, {}, convex);
    await settle();
    expect(starts).toHaveLength(1);
    expect(starts[0].mode).toBe("semantic");

    if (surface === "wall") {
      mounted.container.querySelector<HTMLButtonElement>('[aria-label="Xearch home"]')!.click();
      await settle();
    }

    const author = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Search @alice"]',
    );

    expect(author).not.toBeNull();
    author!.click();
    await settle();
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ raw: "@alice", sort: "newest", mode: "keyword" });
    expect(new URLSearchParams(window.location.search).get("mode")).not.toBe("semantic");
    expect(mounted.html()).not.toContain("Semantic search needs some text");
  },
);
