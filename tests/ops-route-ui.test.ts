// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { fakeConvex, mount, settle, type Mounted } from "./solid";

/**
 * `/ops` opens the operator dashboard (src/locationStore.ts `opsEntryPatch`,
 * applied at the top of src/App.tsx). Vitest has no build-time alias, so
 * this renders the operator build; the public build's side of
 * `opsEntryPatch` is covered in tests/locationStore.test.ts.
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
function rendered(app: Mounted, selector: string) {
  return vi.waitFor(() => {
    app.html();
    const element = app.container.querySelector<HTMLElement>(selector);

    if (!element) throw new Error(`${selector} has not rendered`);

    return element;
  });
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("/ops", () => {
  it("opens the dashboard in the operator build and rewrites the address to /", async () => {
    const app = await mountAppAt("/ops?q=theo");

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    await rendered(app, "main.control-room");
    expect(app.html()).not.toContain("Page not found");
  });

  it("opens the dashboard, not the Queue page, for /ops?queue=1", async () => {
    const app = await mountAppAt("/ops?queue=1");

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    await rendered(app, "main.control-room");
  });

  it("replaces the /ops entry in place, so Back leaves without a rewrite loop", async () => {
    window.history.replaceState(null, "", "/?search=1&q=before");
    window.history.pushState(null, "", "/ops");
    const entries = window.history.length;
    const app = await mountAppAt("/ops");

    await rendered(app, "main.control-room");
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(entries);

    window.history.back();
    await rendered(app, "#query");

    expect(`${window.location.pathname}${window.location.search}`).toBe("/?search=1&q=before");
    expect(window.history.length).toBe(entries);
    expect(app.container.querySelector("main.control-room")).toBeNull();
  });

  it("closing the dashboard opened at /ops lands on the search home at /", async () => {
    const app = await mountAppAt("/ops");
    const close = await rendered(app, "main.control-room .logo");

    close.click();
    await settle();

    expect(window.location.pathname).toBe("/");
    expect(app.container.querySelector("main.control-room")).toBeNull();
    expect(app.container.querySelector("#query")).not.toBeNull();
  });
});
