// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { withViewTransition } from "../src/viewTransition";

afterEach(() => {
  Reflect.deleteProperty(document, "startViewTransition");
});

// A stand-in for the browser's API: runs the callback and rejects all three
// promises when it throws, as the View Transitions spec does.
function fakeStartViewTransition(callback: () => void) {
  let outcome: Promise<void>;

  try {
    callback();
    outcome = Promise.resolve();
  } catch (error) {
    outcome = Promise.reject(error);
  }

  return { updateCallbackDone: outcome, ready: outcome, finished: outcome };
}

describe("withViewTransition", () => {
  it("reports a failing view update instead of leaving it unhandled", async () => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: fakeStartViewTransition,
    });

    const failure = new Error("view update failed");
    const report = vi.fn();

    withViewTransition(() => {
      throw failure;
    }, report);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(report).toHaveBeenCalledWith(failure, "view-transition");
  });
});
