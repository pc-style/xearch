import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import Dashboard from "../src/Dashboard";
import { fakeConvex, mount, stripMarkers } from "./solid";

/**
 * The coordinator-flagged gap this closes: `jobs.start` is
 * `requireOperator`-gated server-side (convex/access.ts) exactly like
 * Cancel/Retry/Dismiss/Restore, but the dashboard's own "Start an import"
 * submit button was never gated on `isOperator` in the UI — a signed-in
 * non-operator caller would hit a bare ConvexError with no warning, unlike
 * every other provider-spending action in this app. This asserts the
 * submit button disables and the sign-in notice appears once `isOperator`
 * is known to be false, and that neither shows for an operator.
 *
 * Renders under the fake Convex app in tests/solid.ts. Every query this
 * doesn't care about (Library's summary/health/rows/limits) is left unset on
 * purpose — Library already renders an explicit, non-crashing "still
 * loading" state for that (see library-ui.test.ts's first test).
 */

const operatorConfig = {
  indexing: true,
  search: true,
  firecrawl: true,
  openai: true,
  email: true,
  xmd: true,
  handoff: true,
  handoffState: { kind: "configured" as const, ok: true },
  collectorMode: "receiver" as const,
};

function renderDashboard(isOperator: boolean) {
  const convex = fakeConvex({
    results: [
      [api.integrations.operator, operatorConfig],
      [api.jobs.list, { jobs: [], truncated: false }],
      [api.access.isOperator, isOperator],
    ],
  });

  const mounted = mount(
    Dashboard,
    { ensureSession: () => Promise.resolve(), close: () => {}, onOpenQueue: () => {} },
    convex,
  );

  return {
    html: stripMarkers(mounted.html()),
    container: mounted.container,
    unmount: mounted.unmount,
  };
}

describe("Dashboard's 'Start an import' form (src/Dashboard.tsx)", () => {
  it("disables the submit button and shows the sign-in notice for a non-operator", () => {
    const { html, container, unmount } = renderDashboard(false);
    // SAFETY: `querySelector` types every result as the loosest `Element`
    // subtype for the given selector; `button.control-start` is always
    // rendered as a real `<button>` in this component's JSX, never
    // replaced with another tag, so this narrows to the concrete type this
    // test's `.disabled` assertion needs.
    const submit = container.querySelector("button.control-start") as HTMLButtonElement | null;

    expect(submit).not.toBeNull();
    expect(submit!.disabled).toBe(true);
    expect(html).toContain("This action runs from the operator dashboard.");
    unmount();
  });

  it("leaves the submit button enabled with no sign-in notice for an operator", () => {
    const { html, container, unmount } = renderDashboard(true);
    // SAFETY: same as the non-operator test above.
    const submit = container.querySelector("button.control-start") as HTMLButtonElement | null;

    expect(submit).not.toBeNull();
    expect(submit!.disabled).toBe(false);
    expect(html).not.toContain("This action runs from the operator dashboard.");
    unmount();
  });
});
