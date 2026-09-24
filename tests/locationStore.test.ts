import { describe, expect, it } from "vitest";
import { parseLocation, previewPatch } from "../src/locationStore";
import { ViewMode } from "../src/uiState";

describe("parseLocation", () => {
  it("defaults to the search view when there is no view param", () => {
    expect(parseLocation("https://xearch.invalid/?q=theo").view).toBe(ViewMode.Search);
  });

  it("reads a bookmarks view from the URL", () => {
    expect(parseLocation("https://xearch.invalid/?view=bookmarks").view).toBe(ViewMode.Bookmarks);
  });

  it("falls back to the search view for an unrecognized view value", () => {
    expect(parseLocation("https://xearch.invalid/?view=nonsense").view).toBe(ViewMode.Search);
  });

  it("reads ?search=1 (the operator build's escape hatch back to the search view — src/App.tsx)", () => {
    expect(parseLocation("https://xearch.invalid/").search).toBe(false);
    expect(parseLocation("https://xearch.invalid/?search=1").search).toBe(true);
  });

  it("reads ?stats=1 into includeStats, and defaults to false without it (N2)", () => {
    expect(parseLocation("https://xearch.invalid/?q=theo").includeStats).toBe(false);
    expect(parseLocation("https://xearch.invalid/?q=theo&stats=1").includeStats).toBe(true);
  });
});

describe("previewPatch", () => {
  it("adds ?view=bookmarks and drops it again for the search view", () => {
    const withBookmarks = previewPatch("https://xearch.invalid/?q=theo", {
      view: ViewMode.Bookmarks,
    });

    expect(withBookmarks).toBe("/?q=theo&view=bookmarks");

    const backToSearch = previewPatch(withBookmarks, { view: ViewMode.Search });
    expect(backToSearch).toBe("/?q=theo");
  });

  it("opening the dashboard clears a stale q= instead of carrying it over", () => {
    const dashboardUrl = previewPatch("https://xearch.invalid/?q=%40anthropicai&sort=relevance", {
      dashboard: true,
      raw: "",
    });

    expect(dashboardUrl).toBe("/?sort=relevance&dashboard=1");
  });

  it("leaves other params alone when only dashboard is toggled off", () => {
    expect(previewPatch("https://xearch.invalid/?dashboard=1", { dashboard: false })).toBe("/");
  });

  it("toggles ?search=1 on and off independently of dashboard", () => {
    expect(previewPatch("https://xearch.invalid/", { search: true })).toBe("/?search=1");
    expect(previewPatch("https://xearch.invalid/?search=1", { search: false })).toBe("/");
  });

  it("toggles ?stats=1 on and off, keeping the rest of the URL (N2 — 'Stats for nerds' must round-trip through the URL, not just be read from it)", () => {
    const withStats = previewPatch("https://xearch.invalid/?q=theo&sort=newest", {
      includeStats: true,
    });

    expect(withStats).toBe("/?q=theo&sort=newest&stats=1");

    const withoutStats = previewPatch(withStats, { includeStats: false });
    expect(withoutStats).toBe("/?q=theo&sort=newest");
  });
});
