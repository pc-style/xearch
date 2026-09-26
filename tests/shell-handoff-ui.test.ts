// @vitest-environment jsdom
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

/** The static form as index.html holds it, typed into (and maybe submitted). */
function staticShell(typed: string, submitted: boolean) {
  const root = document.createElement("div");
  root.innerHTML = `<form id="form" role="search"><input id="query" type="search" /></form>`;
  document.body.appendChild(root);
  root.querySelector<HTMLInputElement>("#query")!.value = typed;

  if (submitted) root.querySelector<HTMLFormElement>("#form")!.dataset.submitted = "1";

  return root;
}

function app() {
  const started: string[] = [];

  const convex = fakeConvex({
    query: (name) => {
      if (name === "integrations:configured")
        return { indexing: true, search: true, firecrawl: false, openai: false, email: false };

      if (name === "search:accounts") return [];

      return undefined;
    },
    mutation: async (name, args) => {
      if (name === "search:start") started.push(String(args.raw));

      return null;
    },
  });

  return { convex, started };
}

describe("the static shell's handoff to the app", () => {
  it("submits a search entered before the app loaded", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?search=1");
    const shell = captureShell(staticShell("local-first software", true));
    expect(shell).toEqual({ typed: "local-first software", focused: false, submitted: true });

    const { convex, started } = app();
    mounted = mount(App, {}, convex);
    replayShell(shell, mounted.container);

    await vi.waitFor(() => {
      mounted?.html();
      expect(started).toEqual(["local-first software"]);
    });
  });

  it("only restores the text when nothing was submitted", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/?search=1");
    const shell = captureShell(staticShell("draft", false));

    const { convex, started } = app();
    mounted = mount(App, {}, convex);
    replayShell(shell, mounted.container);
    mounted.html();
    await Promise.resolve();

    expect(mounted.container.querySelector<HTMLInputElement>("#query")?.value).toBe("draft");
    expect(started).toEqual([]);
  });
});
