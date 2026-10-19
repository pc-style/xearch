// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import App from "../src/App";
import JevLab from "../src/jev/JevLab";
import { fakeConvex, mount, settle, type Mounted } from "./solid";

/**
 * /pc-jev (src/jev/JevLab.tsx). Vitest has no build-time alias, so App
 * renders the operator build here, the same as tests/ops-route-ui.test.ts.
 */
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const post = (tweetId: string, text: string) => ({
  tweetId,
  author: `author${tweetId}`,
  text,
  url: `https://x.com/author${tweetId}/status/${tweetId}`,
  links: [],
  likes: 10,
});

const candidates = {
  rows: [post("1", "first literal"), post("2", "second literal"), post("3", "third literal")],
  total: 42,
  warnings: [],
};

const ranking = {
  intent: { key: "news", label: "news", confidence: 0.82 },
  pick: [0.1, 0.2, 0.7],
  score: [0.3, 0.9, 0.5],
  ms: { intent: 120, rank: 300, total: 430 },
  inputTokens: 5_400,
};

function order(app: Mounted, column: string) {
  return [
    ...app.container.querySelectorAll(`section[aria-label="${column}"] .jev-card .jev-body p`),
  ].map((p) => p.textContent);
}

async function searchFor(app: Mounted, text: string) {
  const input = app.container.querySelector<HTMLInputElement>(".jev-form input")!;

  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await settle();
  app.container.querySelector<HTMLFormElement>(".jev-form")!.requestSubmit();
  await vi.waitFor(() => {
    app.html();

    if (order(app, "Search service order").length === 0) throw new Error("no literal results");
  });
}

function jevButton(app: Mounted) {
  return app.container.querySelector<HTMLButtonElement>(".jev-it")!;
}

describe("/pc-jev route", () => {
  it.each(["/pc-jev", "/pc-jev/"])("renders the Jev page at %s", async (path) => {
    window.history.replaceState(null, "", path);
    mounted = mount(App, {}, fakeConvex({ isAuthenticated: false }));
    await settle();

    const app = mounted;

    await vi.waitFor(() => {
      if (!app.html().includes("jev search")) throw new Error("not rendered");
    });
    expect(app.html()).not.toContain("Page not found");
    expect(window.location.pathname).toBe(path);
  });
});

describe("Jev search page", () => {
  it("searches, then shows Jev's order beside the literal one", async () => {
    const calls: string[] = [];

    mounted = mount(
      JevLab,
      { ensureSession: () => Promise.resolve() },
      fakeConvex({
        action: (name, args) => {
          calls.push(name);

          if (name === "jev:candidates") return Promise.resolve(candidates);

          expect(args).toMatchObject({ raw: "launch week" });

          return Promise.resolve(ranking);
        },
      }),
    );

    const app = mounted;

    expect(jevButton(app).disabled).toBe(true);
    await searchFor(app, "launch week");
    expect(order(app, "Search service order")).toEqual([
      "first literal",
      "second literal",
      "third literal",
    ]);
    expect(
      app.container.querySelector('section[aria-label="Search service order"] .jev-col-head span')
        ?.textContent,
    ).toBe("3 of 42 matches");

    jevButton(app).click();
    await vi.waitFor(() => {
      app.html();

      if (order(app, "Jev order").length === 0) throw new Error("no jev results");
    });

    // "score" is the default method: 0.9, 0.5, 0.3.
    expect(order(app, "Jev order")).toEqual(["second literal", "third literal", "first literal"]);
    expect(app.container.querySelector(".jev-stats")?.textContent).toContain(
      "wants news (82% sure)",
    );

    app.container.querySelector<HTMLButtonElement>('.jev-methods button[title*="choice"]')!.click();
    await settle();
    expect(order(app, "Jev order")).toEqual(["third literal", "second literal", "first literal"]);
    expect(calls).toEqual(["jev:candidates", "jev:rank"]);
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows why Jev failed and keeps the literal results", async () => {
    mounted = mount(
      JevLab,
      { ensureSession: () => Promise.resolve() },
      fakeConvex({
        action: (name) =>
          name === "jev:candidates"
            ? Promise.resolve(candidates)
            : Promise.reject(
                new ConvexError("Add TYPESAFE_API_KEY to this deployment to use Jev."),
              ),
      }),
    );

    const app = mounted;

    await searchFor(app, "launch week");
    jevButton(app).click();
    await vi.waitFor(() => {
      if (!app.html().includes("TYPESAFE_API_KEY")) throw new Error("no error yet");
    });
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Add TYPESAFE_API_KEY",
    );
    expect(order(app, "Search service order")).toHaveLength(3);
  });
});
