// Older imports stored posts without an avatar URL; the results list used to
// show initials for those rows even though the imported account knows the
// picture. The list now falls back to the account's avatar (as the home wall
// already did).
import { describe, expect, it } from "vitest";
import { post, renderResults as render, session } from "./fixtures/results";

describe("result rows fall back to the account avatar", () => {
  it("uses the account avatar when the row has none", () => {
    const row = post({ author: "theo", avatar: undefined });

    const html = render({
      result: session({ rows: [row] }),
      visible: [row],
      avatarFor: (handle) => (handle === "theo" ? "https://img.example/theo.jpg" : undefined),
    });

    expect(html).toContain('src="https://img.example/theo.jpg"');
  });

  it("prefers the row's own avatar when present", () => {
    const row = post({ author: "theo", avatar: "https://img.example/row.jpg" });

    const html = render({
      result: session({ rows: [row] }),
      visible: [row],
      avatarFor: () => "https://img.example/account.jpg",
    });

    expect(html).toContain('src="https://img.example/row.jpg"');
    expect(html).not.toContain("account.jpg");
  });

  it("still shows initials when neither knows an avatar", () => {
    const row = post({ author: "theo", avatar: undefined });

    const html = render({ result: session({ rows: [row] }), visible: [row] });

    expect(html).toContain(">TH<");
  });
});
