// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import App from "../src/App";
import { fakeConvex, mount, settle, stripMarkers, type Mounted } from "./solid";

/**
 * index.html carries a static copy of the home page's first frame so it can
 * paint before the script arrives (see the comment there and src/main.tsx).
 * If it drifts from what App renders, the swap to the live app jumps. This
 * renders App's home and checks the copy is the same markup.
 */
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** The shell exactly as index.html holds it. */
function shell(): string {
  const html = readFileSync("index.html", "utf8");
  const match = html.match(/<!--shell-->([^]*?)<!--\/shell-->/);

  if (!match?.[1]) throw new Error("index.html has no shell");

  return match[1];
}

/** App's home as the public build renders it. Tests run the operator
 * build (no build-time alias), so its two operator-only controls go. */
async function home(): Promise<string> {
  window.history.replaceState(null, "", "/?search=1");
  mounted = mount(App, {}, fakeConvex({ isAuthenticated: false }));
  await settle();

  return (
    stripMarkers(mounted.html())
      .replace(
        /<button type="button" class="nav" aria-label="Import dashboard">[^]*?<\/button>/,
        "",
      )
      // The shell paints before the first status read, so it has no time yet.
      .replace(/ · last read [^"]*"/, '"')
      .replace(
        /<button type="button"><svg[^>]*width="13"[^>]*>[^]*?<\/svg>Connections<\/button>/,
        "",
      )
  );
}

/** `html` as a DOM tree printed without formatting whitespace — index.html
 * is run through the formatter, App's markup is not. */
function normalized(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const blank: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // SAFETY: the walker only visits text nodes (SHOW_TEXT).
    const text = node as Text;

    if (!text.data.trim()) blank.push(text);
    else text.data = text.data.replace(/\s+/g, " ");
  }

  for (const text of blank) text.remove();

  return template.innerHTML;
}

describe("index.html's static home shell", () => {
  it("is the markup App renders for the home page", async () => {
    const expected = (await home())
      .replace('<div class="page">', '<div class="page" data-shell="">')
      .replace(
        '<form id="form" role="search">',
        '<form id="form" role="search" onsubmit="return false;">',
      );

    expect(normalized(shell())).toBe(normalized(expected));
  });
});
