// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { fakeConvex, mount, settle, type Mounted } from "./solid";

/**
 * The operator dashboard lives at `/ops` and `/ops/<tab>` as real paths
 * (src/locationStore.ts `opsTabFromPath`, `opsEntryPatch`). Vitest has no
 * build-time alias, so this renders the operator build; the public build's
 * side of `opsEntryPatch` is covered in tests/locationStore.test.ts.
 */
let mounted: Mounted | null = null;

async function mountAppAt(path: string) {
  window.history.replaceState(null, "", path);
  // Signed out, so the dashboard's own queries skip rather than wait on
  // fixtures this test has no use for.
  mounted = mount(App, {}, fakeConvex({ isAuthenticated: false }));
  await settle();

  return mounted;
}

/** Wait for `selector` to render: the dashboard is a lazy import. */
function rendered(app: Mounted, selector: string, text?: string) {
  return vi.waitFor(() => {
    app.html();

    const element = [...app.container.querySelectorAll<HTMLElement>(selector)].find(
      (el) => text === undefined || el.textContent?.includes(text),
    );

    if (!element) throw new Error(`${selector} has not rendered`);

    return element;
  });
}

const address = () => `${window.location.pathname}${window.location.search}`;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("/ops routes", () => {
  it("opens the overview at /ops and keeps the address", async () => {
    const app = await mountAppAt("/ops");

    expect((await rendered(app, "main.ops .opsnav a.on")).textContent).toBe("Overview");
    expect(address()).toBe("/ops");
    expect(app.html()).not.toContain("Page not found");
  });

  it.each([
    ["/ops/accounts", "Accounts"],
    ["/ops/jobs", "Jobs"],
    ["/ops/imports", "Other imports"],
    ["/ops/performance", "Performance"],
    ["/ops/provider", "Provider"],
  ])("opens %s on its own tab", async (path, label) => {
    const app = await mountAppAt(path);

    expect((await rendered(app, "main.ops .opsnav a.on")).textContent).toBe(label);
    expect(address()).toBe(path);
  });

  it("sends a bare / to /ops in place, without a new history entry", async () => {
    const entries = window.history.length;
    const app = await mountAppAt("/");

    await rendered(app, "main.ops");
    expect(address()).toBe("/ops");
    expect(window.history.length).toBe(entries);
  });

  it("sends the old ?queue=1 address to the Jobs tab", async () => {
    const app = await mountAppAt("/?queue=1");

    expect((await rendered(app, "main.ops .opsnav a.on")).textContent).toBe("Jobs");
    expect(address()).toBe("/ops/jobs");
  });

  it("drops search state from a dashboard address", async () => {
    const app = await mountAppAt("/ops/provider?q=theo&search=1");

    expect((await rendered(app, "main.ops .opsnav a.on")).textContent).toBe("Provider");
    expect(address()).toBe("/ops/provider");
  });

  it("switches tabs with real history entries, so Back and Forward work", async () => {
    const app = await mountAppAt("/ops");
    const entries = window.history.length;

    (await rendered(app, "main.ops .opsnav a", "Accounts")).click();
    expect((await rendered(app, "main.ops .opsnav a.on")).textContent).toBe("Accounts");
    expect(address()).toBe("/ops/accounts");
    expect(window.history.length).toBe(entries + 1);

    window.history.back();
    await vi.waitFor(() => expect(address()).toBe("/ops"));
    expect((await rendered(app, "main.ops .opsnav a.on")).textContent).toBe("Overview");

    window.history.forward();
    await vi.waitFor(() => expect(address()).toBe("/ops/accounts"));
    expect((await rendered(app, "main.ops .opsnav a.on")).textContent).toBe("Accounts");
  });

  it("leaves a modified click on a tab to the browser", async () => {
    const app = await mountAppAt("/ops");
    const link = await rendered(app, "main.ops .opsnav a", "Jobs");

    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    await settle();
    expect(address()).toBe("/ops");
  });

  it("Public site opens search at /?search=1, and Back returns to the dashboard", async () => {
    const app = await mountAppAt("/ops/jobs");

    (await rendered(app, "main.ops .who button", "Public site")).click();
    await rendered(app, "#query");
    expect(address()).toBe("/?search=1");
    expect(app.container.querySelector("main.ops")).toBeNull();

    window.history.back();
    expect((await rendered(app, "main.ops .opsnav a.on")).textContent).toBe("Jobs");
  });

  it("still says page not found for an unknown dashboard tab", async () => {
    const app = await mountAppAt("/ops/nope");

    await rendered(app, ".not-found");
    expect(app.container.querySelector("main.ops")).toBeNull();
  });
});
