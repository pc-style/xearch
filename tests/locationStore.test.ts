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
});
