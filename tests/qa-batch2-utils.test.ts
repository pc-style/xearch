// Small pure-function coverage for the second QA batch (2026-09-24):
// - A17 (/tmp/issues-claude-qa.md): ring/strip avatars used x.md's `_normal`
//   (48px) variant at ~46px CSS, visibly soft on retina.
// - A14 (/tmp/issues-claude-qa.md): unknown paths rendered the full home
//   page with a 200 instead of a "not found" state.
import { describe, expect, it } from "vitest";
import { ringAvatarUrl } from "../src/avatarUrl";
import { parseLocation } from "../src/locationStore";

describe("A17: ringAvatarUrl", () => {
  it("rewrites the _normal size variant to _bigger", () => {
    expect(ringAvatarUrl("https://pbs.twimg.com/profile_images/1/XP8gyBaY_normal.jpg")).toBe(
      "https://pbs.twimg.com/profile_images/1/XP8gyBaY_bigger.jpg",
    );
  });

  it("preserves a query string after the extension", () => {
    expect(ringAvatarUrl("https://example.com/a_normal.png?v=2")).toBe(
      "https://example.com/a_bigger.png?v=2",
    );
  });

  it("passes through URLs that aren't the _normal variant unchanged", () => {
    expect(ringAvatarUrl("https://example.com/a_bigger.jpg")).toBe(
      "https://example.com/a_bigger.jpg",
    );
  });

  it("passes through undefined", () => {
    expect(ringAvatarUrl(undefined)).toBeUndefined();
  });
});

describe("A14: LocationSnapshot exposes the real pathname", () => {
  it("reports '/' for the app's own root", () => {
    expect(parseLocation("https://xearch.example/?q=theo").path).toBe("/");
  });

  it("reports an unknown path as itself, not silently '/'", () => {
    expect(parseLocation("https://xearch.example/nope/does-not-exist").path).toBe(
      "/nope/does-not-exist",
    );
  });
});
