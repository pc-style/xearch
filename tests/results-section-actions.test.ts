// QA reports /tmp/issues-claude-qa.md A12 and /tmp/issues-claude-preview.md
// P2 (2026-09-24):
// - A12: "Save search" never showed a saved state, so clicking it twice
//   looked like nothing happened.
// - P2: the "Stats for nerds" panel rendered on every search regardless of
//   the checkbox, because it was gated on `frontendStats` existing rather
//   than the caller's includeStats choice — client telemetry is always
//   populated once a search runs.
import { describe, expect, it } from "vitest";
import {
  frontendStats,
  post,
  renderHead,
  renderResults as render,
  session,
} from "./fixtures/results";

const complete = { result: session({ rows: [post()] }), visible: [post()] };

describe("A12: Save search reflects whether the current query+sort is already saved", () => {
  it("offers 'Save search' when not yet saved", () => {
    const html = renderHead({ alreadySaved: false });
    expect(html).toContain('aria-label="Save search"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("shows the saved state once it is, and offers to remove it", () => {
    const html = renderHead({ alreadySaved: true });
    expect(html).toContain('aria-label="Remove saved search"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toMatch(/class="ib saved"/);
  });
});

describe("P2: the nerd stats panel only renders when the caller asked for it", () => {
  it("stays hidden when statsForNerds is off, even though client telemetry exists", () => {
    const html = render({ ...complete, statsForNerds: false, frontendStats });
    expect(html).not.toContain("Stats for nerds —");
  });

  it("renders once statsForNerds is on", () => {
    const html = render({ ...complete, statsForNerds: true, frontendStats });
    expect(html).toContain("Stats for nerds —");
  });

  it("names the sort in the result count only for nerds", () => {
    expect(render({ ...complete, sort: "likes", statsForNerds: true })).toContain(
      "1 post loaded · most liked",
    );
    expect(render({ ...complete, sort: "likes", statsForNerds: false })).not.toContain(
      "most liked",
    );
  });
});

describe("B6: results footnote drops the internal service copy", () => {
  it("does not mention 'search service' for the search view", () => {
    const html = render(complete);
    expect(html).not.toMatch(/search service/i);
  });
});

describe("operator authorization boundary in the results UI", () => {
  // Provider-spending actions (Web context, Import from X, Fetch
  // conversation, reading a linked page) cannot run on the public site, so
  // they aren't offered there at all; the server enforces the boundary
  // regardless (convex/access.ts `requireOperator`).
  it("leaves Web context, Import from X and Fetch conversation out for a non-operator", () => {
    const head = renderHead({ isOperator: false });
    const results = render({ ...complete, isOperator: false });

    expect(head).not.toContain("Web context");
    expect(head).not.toContain("Import from X");
    expect(results).not.toContain("Fetch conversation");
  });

  it("offers them, enabled, to an operator", () => {
    const head = renderHead({ isOperator: true });
    const results = render({ ...complete, isOperator: true });

    const disabled = (label: string) =>
      new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>)[\\s\\S])*${label}`);

    expect(head).toContain("Web context");
    expect(head).toContain("Import from X");
    expect(results).toContain("Fetch conversation");
    expect(head).not.toMatch(disabled("Web context"));
    expect(head).not.toMatch(disabled("Import from X"));
  });

  it("while the operator check is loading, offers nothing it might have to take back", () => {
    const head = renderHead({ isOperator: undefined });
    const results = render({ ...complete, isOperator: undefined });

    expect(head).not.toContain("Web context");
    expect(results).not.toContain("Fetch conversation");
  });

  it("leaves a post's linked-page buttons out for a non-operator (CodeRabbit #4089730732)", () => {
    const withLink = { ...post(), links: ["https://example.com/article"] };
    const html = render({ ...complete, isOperator: false, visible: [withLink] });

    expect(html).not.toContain("example.com</span>");
  });

  it("offers a post's linked-page buttons, enabled, to an operator", () => {
    const withLink = { ...post(), links: ["https://example.com/article"] };
    const html = render({ ...complete, isOperator: true, visible: [withLink] });

    expect(html).toContain("example.com</span>");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*example\.com/);
  });
});
