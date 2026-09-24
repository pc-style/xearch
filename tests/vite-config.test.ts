import { describe, expect, it } from "vitest";
import { relativeModule } from "../vite.config";

/**
 * CodeRabbit #4090910250: the public build's alias for `./operatorSurface` /
 * `./operatorBuild` / `./operatorToken` originally matched only a specifier
 * written exactly as `./name`, so `src/library/AccountRow.tsx` and
 * `ActiveQueue.tsx` importing `../operatorToken` would have pulled in the
 * real, un-swapped module (with `VITE_OPERATOR_TOKEN` in it) had they ever
 * been reachable from the public build. `relativeModule` fixes that by
 * matching any relative depth; these tests pin its behavior directly since
 * the regex itself isn't exercised by a normal app import.
 */
describe("vite.config's relativeModule", () => {
  const pattern = relativeModule("operatorToken");

  it("matches a same-directory import", () => {
    expect(pattern.test("./operatorToken")).toBe(true);
  });

  it("matches a one-level-deep import, the exact shape CodeRabbit flagged", () => {
    expect(pattern.test("../operatorToken")).toBe(true);
  });

  it("matches arbitrarily deep imports", () => {
    expect(pattern.test("../../../operatorToken")).toBe(true);
  });

  it("does not match a bare specifier or an unrelated relative import", () => {
    expect(pattern.test("operatorToken")).toBe(false);
    expect(pattern.test("./somewhereElse")).toBe(false);
  });

  it("does not partially match a longer name sharing the same prefix", () => {
    expect(pattern.test("./operatorTokenExtra")).toBe(false);
    expect(pattern.test("./operatorToken.public")).toBe(false);
  });
});
