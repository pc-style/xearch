import { afterEach, expect, it, vi } from "vitest";
import type { Value } from "convex/values";
import App from "../src/App";
import * as analytics from "../src/posthog";
import { fakeConvex, mount, settle, type Mounted } from "./solid";

let mounted: Mounted | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

it.each([
  { mode: "keyword", status: "complete", event: "search_results_loaded" },
  { mode: "semantic", status: "complete", event: "search_results_loaded" },
  { mode: "keyword", status: "failed", event: "search_failed" },
  { mode: "semantic", status: "failed", event: "search_failed" },
])("reports $mode on a $status search outcome exactly once", async ({ mode, status, event }) => {
  const capture = vi.spyOn(analytics, "capture");

  window.history.replaceState(null, "", `/?search=1&q=software&mode=${mode}`);
  let session: Value = null;

  const convex = fakeConvex({
    query: (name) => {
      if (name === "integrations:configured")
        return {
          indexing: true,
          search: true,
          semantic: true,
          firecrawl: false,
          openai: false,
          email: false,
        };

      if (name === "search:accounts") return [];

      if (name === "search:resultsByKey") return session;

      return undefined;
    },
    mutation: async (name, args) => {
      if (name !== "search:start") return null;
      session = {
        _id: "session-1",
        _creationTime: Date.now(),
        owner: "user-1",
        raw: args.raw,
        clientKey: args.clientKey,
        sort: args.sort,
        mode: args.mode,
        includeStats: false,
        status,
        rows: [],
        warnings: [],
      };
      queueMicrotask(() => convex.changed("search:resultsByKey"));

      return "session-1";
    },
  });

  mounted = mount(App, {}, convex);
  await settle();
  expect(capture).toHaveBeenCalledWith(
    event,
    expect.objectContaining({ mode, session_id: "session-1" }),
  );
  convex.changed("search:resultsByKey");
  await settle();
  expect(capture.mock.calls.filter(([name]) => name === event)).toHaveLength(1);
});
