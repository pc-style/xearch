import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { Job } from "../src/Dashboard";
import { fakeConvex, mount, settle } from "./solid";

/**
 * CodeRabbit (PR #52, src/Dashboard.tsx:71): Cancel/Retry/Dismiss all run
 * through JobRow's own `useTask`, which surfaces a rejected mutation as a
 * `role="alert"` line. "Bring back" (restore) is a dashboard-only extra
 * rendered outside JobRow (src/JobRow.tsx never learns about it — see its
 * own doc comment), and it used to call the mutation directly with no error
 * handling at all: a failed restore (expired session, dropped connection)
 * threw an unhandled rejection and the operator never saw why the row
 * didn't come back. This asserts the fixed behavior — `restoreTask` reports
 * the failure the same way JobRow's own actions do.
 *
 * Renders under the fake Convex app in tests/solid.ts, whose `restore`
 * mutation rejects the way a dropped connection would.
 */

function jobId(id: string) {
  // SAFETY: `Id<"jobs">` is `string & { __tableName: "jobs" }`, a subtype of
  // `string`; this fixture helper attaches that brand to a test-authored id.
  return id as Id<"jobs">;
}

function userId(id: string) {
  // SAFETY: same as `jobId` above, for `Id<"users">`.
  return id as Id<"users">;
}

function dismissedJob(): Doc<"jobs"> {
  const base = {
    _id: jobId("job-1"),
    _creationTime: 0,
    owner: userId("user-1"),
    kind: "live" as const,
    input: "@theo convex",
    refresh: false,
    status: "complete" as const,
    count: 0,
    attempt: 0,
    warnings: [],
    updatedAt: 0,
    dismissedAt: 0,
  };

  // SAFETY: `base` covers every required field of `Doc<"jobs">`; this is a
  // plain upcast, not a lie about its shape.
  return base as Doc<"jobs">;
}

describe("Dashboard's Job row (src/Dashboard.tsx)", () => {
  it("shows a failure message when Bring back fails, instead of an unhandled rejection", async () => {
    const restoreName = getFunctionName(api.jobs.restore);

    const convex = fakeConvex({
      mutation: (name) =>
        name === restoreName
          ? Promise.reject(new Error("Reconnecting to your search library…"))
          : Promise.resolve(null),
    });

    const mounted = mount(Job, { job: dismissedJob(), isOperator: true }, convex);

    const button = [...mounted.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Bring back",
    );

    expect(button).toBeDefined();
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Let the rejected mutation promise settle before asserting.
    await settle();

    expect(mounted.html()).toContain("Reconnecting to your search library…");
    mounted.unmount();
  });
});
