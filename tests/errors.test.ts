import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { describeError } from "../src/errors";

describe("job action error text", () => {
  it("reads the intended message out of a ConvexError's data", () => {
    expect(describeError(new ConvexError("This indexing job is already active."))).toBe(
      "This indexing job is already active.",
    );
  });

  it("strips the [CONVEX ...] wrapper Convex adds to an unexpected server error", () => {
    const wrapped = new Error(
      "[CONVEX M(jobs:retry)] [Request ID: abc123] Server Error\nUncaught Error: Enter a valid X handle, without a URL.\n    at handler (../convex/jobs.ts:42:11)",
    );

    expect(describeError(wrapped)).toBe("Enter a valid X handle, without a URL.");
  });

  it("falls back to the plain message when there is no wrapper to strip", () => {
    expect(describeError(new Error("Network request failed"))).toBe("Network request failed");
  });

  it("never surfaces a non-Error throw as-is", () => {
    expect(describeError("some string")).toBe("Something went wrong. Try again.");
  });
});
