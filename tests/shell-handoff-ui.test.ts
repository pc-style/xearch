// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { captureShell, replayShell } from "../src/shellHandoff";
import { fakeConvex, mount, type Mounted } from "./solid";

/**
 * index.html's static search box works before the app script runs. Whatever
 * someone typed, and an Enter pressed meanwhile, must carry into the live app.
 */
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.textContent = "";
  vi.restoreAllMocks();
});

interface Used {
  typed: string;
  submitted?: boolean;
  sort?: string;
  stats?: boolean;
}

/** index.html's static shell, used before the app loaded. */
function staticShell({ typed, submitted = false, sort, stats = false }: Used) {
  const html = readFileSync("index.html", "utf8").match(/<!--shell-->([^]*?)<!--\/shell-->/)?.[1];

  if (!html) throw new Error("index.html has no shell");

  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  root.querySelector<HTMLInputElement>("#query")!.value = typed;

  if (sort) root.querySelector<HTMLSelectElement>("select.sort")!.value = sort;

  root.querySelector<HTMLInputElement>(".opts input[type=checkbox]")!.checked = stats;

  if (submitted) root.querySelector<HTMLFormElement>("#form")!.dataset.submitted = "1";

  return root;
}

function app() {
  const started: { raw: string; sort: unknown; includeStats: unknown }[] = [];

  const convex = fakeConvex({
    query: (name) => {
      if (name === "integrations:configured")
        return { indexing: true, search: true, firecrawl: false, openai: false, email: false };

      if (name === "search:accounts") return [];

      return undefined;
    },
    mutation: async (name, args) => {
      if (name === "search:start")
        started.push({ raw: String(args.raw), sort: args.sort, includeStats: args.includeStats });

      return null;
    },
  });

  return { convex, started };
}

describe("the static shell's handoff to the app", () => {
  it("submits a search entered before the app loaded", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?search=1");
    const shell = captureShell(staticShell({ typed: "local-first software", submitted: true }));
    expect(shell).toEqual({
      typed: "local-first software",
      focused: false,
      submitted: true,
      sort: "relevance",
      stats: false,
    });

    const { convex, started } = app();
    mounted = mount(App, {}, convex);
    replayShell(shell, mounted.container);

    await vi.waitFor(() => {
      mounted?.html();
      expect(started).toEqual([
        { raw: "local-first software", sort: "relevance", includeStats: false },
      ]);
    });
  });

  it("searches with the sort and stats chosen before the app loaded", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?search=1");

    const shell = captureShell(
      staticShell({ typed: "rust", submitted: true, sort: "newest", stats: true }),
    );

    const { convex, started } = app();
    mounted = mount(App, {}, convex);
    replayShell(shell, mounted.container);

    await vi.waitFor(() => {
      mounted?.html();
      expect(started).toEqual([{ raw: "rust", sort: "newest", includeStats: true }]);
    });
  });

  it("only restores the text when nothing was submitted", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?search=1");
    const shell = captureShell(staticShell({ typed: "draft", sort: "likes" }));

    const { convex, started } = app();
    mounted = mount(App, {}, convex);
    replayShell(shell, mounted.container);
    mounted.html();
    await Promise.resolve();

    expect(mounted.container.querySelector<HTMLInputElement>("#query")?.value).toBe("draft");
    expect(mounted.container.querySelector<HTMLSelectElement>("select.sort")?.value).toBe("likes");
    expect(started).toEqual([]);
  });
});
