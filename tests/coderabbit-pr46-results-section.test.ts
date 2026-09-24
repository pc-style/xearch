// Regression tests for the ResultsSection.tsx CodeRabbit findings on PR #46
// (2026-09-24):
// - Keep the query-driven X import available with zero matches.
// - Announce query validation errors to screen readers.
// - Describe configuration without claiming a connection check.
// - Make statistics accessible after a zero-match search.
import { describe, expect, it } from "vitest";
import {
  frontendStats,
  configured,
  post,
  renderResults as render,
  session,
} from "./fixtures/results";

describe("keep the query-driven X import available with zero matches", () => {
  it("shows 'Import from X' alongside 'Import an account' on a zero-match search", () => {
    const html = render({ result: session() });
    expect(html).toContain("Import from X");
    expect(html).toContain("Import an account");
  });

  it("offers only 'Import an account' where importing from X can't run (not an operator)", () => {
    const html = render({ result: session(), isOperator: false });
    expect(html).not.toContain("Import from X");
    expect(html).toContain("Import an account");
  });
});

describe("announce query validation errors to screen readers", () => {
  it("marks the invalid-query state as an alert", () => {
    const html = render({ queryError: "Search one author at a time." });
    expect(html).toMatch(/<div class="empty" role="alert">/);
  });

  it("keeps the results status text in a live region", () => {
    const html = render({ result: session() });
    expect(html).toMatch(/<section class="results" aria-live="polite">/);
  });
});

describe("describe configuration without claiming a connection check", () => {
  it("says configuration is pending, not that a connection is being checked", () => {
    const html = render({ configured: undefined });
    expect(html).toContain("Checking configuration…");
    expect(html).not.toMatch(/checking.*connection/i);
  });

  it("says search isn't configured, not that it isn't available", () => {
    const html = render({ configured: { ...configured, search: false } });
    expect(html).toMatch(/Search isn.{1,10}t configured on this site\./);
    expect(html).not.toMatch(/Search is not available on this site\./);
  });

  it("states the configuration requirement without claiming it alone enables search or calling it a connection (2nd CodeRabbit pass)", () => {
    const html = render({ configured: { ...configured, search: false } });
    expect(html).toContain("Search needs the search service to be configured for this site.");
    expect(html).not.toMatch(/<p>[^<]*connection[^<]*<\/p>/i);
    expect(html).not.toMatch(/will enable it/i);
  });
});

describe("uses singular 'post' for exactly one result loaded (2nd CodeRabbit pass)", () => {
  it("says '1 post' rather than '1 posts'", () => {
    const html = render({ result: session({ rows: [post()] }), visible: [post()] });
    expect(html).toContain("1 post loaded");
    expect(html).not.toContain("1 posts loaded");
  });

  it("still says 'N posts' for more than one", () => {
    const rows = [post(), post({ tweetId: "456" })];
    const html = render({ result: session({ rows }), visible: rows });
    expect(html).toContain("2 posts loaded");
  });

  it("counts the merged rows after 'Load more', not just the latest page (N1)", () => {
    // `result` is only the most recently landed backend page; `visible` is
    // what App.tsx renders after folding each page into the list.
    const firstPage = [post(), post({ tweetId: "456" })];
    const secondPage = [post({ tweetId: "789" })];

    const html = render({
      result: session({ rows: secondPage }),
      visible: [...firstPage, ...secondPage],
    });

    expect(html).toContain("3 posts loaded");
    expect(html).not.toContain("1 post loaded");
  });
});

describe("make statistics accessible after a zero-match search", () => {
  it("still renders the stats panel when a completed search has zero matches", () => {
    const html = render({ result: session(), statsForNerds: true, frontendStats });

    expect(html).toContain("Stats for nerds —");
  });

  it("does not show stats for a failed search", () => {
    const html = render({
      result: session({ status: "failed", error: "boom" }),
      statsForNerds: true,
      frontendStats,
    });

    expect(html).not.toContain("Stats for nerds");
  });

  it("still works for a non-empty search (no regression)", () => {
    const html = render({
      result: session({ rows: [post()] }),
      visible: [post()],
      statsForNerds: true,
      frontendStats,
    });

    expect(html).toContain("Stats for nerds —");
  });
});
