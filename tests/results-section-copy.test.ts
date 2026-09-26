// QA report /tmp/issues.md items 9, 10, 12, 14 (2026-09-24): the search
// corpus is one shared, global index of every account anyone imported, not
// a personal "library" — copy and disabled-state bugs below all trace back
// to forgetting that.
import { describe, expect, it } from "vitest";
import { ViewMode } from "../src/uiState";
import { post, renderHead, renderResults as render, session } from "./fixtures/results";

describe("item 9: empty-result copy describes the shared corpus, not a personal library", () => {
  it("no-match state never says 'your library'", () => {
    const html = render({ result: session() });

    expect(html).not.toMatch(/your library/i);
    expect(html).toContain("No matches in the indexed accounts yet.");
    // The import CTA stays.
    expect(html).toContain("Import an account");
  });

  it("offers to import an @handle the query names but nobody has imported", () => {
    const html = render({ result: session(), unknownAuthor: "someone" });

    expect(html).toContain("@someone isn’t imported yet");
    expect(html).toContain("Import @someone");
  });
});

describe("item 10: an invalid query does not claim to be searching", () => {
  it("shows the error instead of 'Finding matching posts…'", () => {
    const html = render({ queryError: "Search one author at a time." });
    expect(html).not.toMatch(/Finding matching posts/);
    expect(html).toContain("Adjust your search");
    expect(html).toContain("Search one author at a time.");
  });

  it("hides Web context, Email, and Import from X entirely while the query is invalid (QA A7/B4)", () => {
    // App.tsx computes `hasUsableResults` false for an invalid query, a
    // failed search and zero matches; the whole overflow menu goes, not
    // just its items. Save search stays.
    const html = renderHead({
      queryError: "Search one author at a time.",
      hasUsableResults: false,
    });

    expect(html).not.toContain("Web context");
    expect(html).not.toContain("Email");
    expect(html).not.toContain("Import from X");
    expect(html).not.toContain("More actions");
    expect(html).toContain("Save search");
  });
});

describe("A7: a failed search doesn't say 'Search could not complete' twice", () => {
  it("names the failure once", () => {
    const html = render({
      result: session({
        raw: '""',
        status: "failed",
        error: "The search service rejected this query.",
      }),
    });

    const occurrences = html.split("Search could not complete").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("item 12: guest Email action states what it needs up front", () => {
  it("labels the button 'Email · sign in' when the caller has no verified email", () => {
    const html = renderHead({ emailNeedsSignIn: true });
    expect(html).toContain("Email · sign in");
  });

  it("drops the sign-in hint once signed in with a verified address", () => {
    const html = renderHead({ emailNeedsSignIn: false });
    expect(html).toContain("Email these results");
    expect(html).not.toContain("sign in");
  });
});

describe("item 14: bookmarks view has correct grammar and its own explanation", () => {
  it("uses singular 'post' for exactly one bookmark", () => {
    const html = render({
      view: ViewMode.Bookmarks,
      visible: [post()],
      bookmarkedIds: new Set(["123"]),
    });

    expect(html).toMatch(/1 saved post in this browser/);
    expect(html).not.toMatch(/1 saved posts/);
  });

  it("uses plural 'posts' for more than one bookmark", () => {
    const html = render({
      view: ViewMode.Bookmarks,
      visible: [post(), post({ tweetId: "456" })],
      bookmarkedIds: new Set(["123", "456"]),
    });

    expect(html).toMatch(/2 saved posts in this browser/);
  });

  it("does not reuse the search-specific scope note for bookmarks", () => {
    const html = render({
      view: ViewMode.Bookmarks,
      visible: [post()],
      bookmarkedIds: new Set(["123"]),
    });

    expect(html).not.toMatch(/come from your search service/);
    expect(html).toMatch(/stored in this browser/);
  });

  it("titles the view 'Bookmarks' and offers no save for it", () => {
    const html = renderHead({ view: ViewMode.Bookmarks });

    expect(html).toContain(">Bookmarks</h1>");
    expect(html).not.toContain("Save search");
  });
});

describe("the reply label", () => {
  it("names another account, ignoring handle case for the author's own thread", () => {
    const reply = (replyTo: string) =>
      render({
        result: session({ raw: "hello", rows: [post({ replyTo })] }),
        visible: [post({ replyTo })],
      });

    expect(reply("someone")).toContain("Replying to @someone");
    expect(reply("AnthropicAI")).not.toContain("Replying to");
  });
});
