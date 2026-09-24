// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createSignal, flush } from "solid-js";
import type { Value } from "convex/values";
import { api } from "../convex/_generated/api";
import { useStableQuery } from "../src/library/stableQuery";
import { fakeConvex, mount, type Mounted } from "./solid";

/**
 * The bug this guards: `useLiveNow` ticks the `now` argument of
 * convex/integrations.ts's queries every 5s, and a plain query reports
 * `undefined` for every argument change until the new result arrives, so
 * the whole page flipped back to its loading state every few seconds.
 * `useStableQuery` must hold the last result across that gap.
 */

// Results keyed by the serialized args, so an argument change with no
// result yet reads as `undefined` exactly like a real in-flight refetch.
const responses = new Map<string, Value>();

const [now, setNow] = createSignal<number | "skip">(1);

function Probe() {
  const result = useStableQuery(api.integrations.configured, () => {
    const value = now();

    return value === "skip" ? "skip" : { now: value };
  });

  // Rendered as text so the assertions read the DOM.
  return <output>{result() === undefined ? "undefined" : JSON.stringify(result())}</output>;
}

let mounted: Mounted | undefined;

function seen(): Value | undefined {
  const text = mounted?.container.textContent ?? "undefined";

  return text === "undefined" ? undefined : JSON.parse(text);
}

function render(value: number | "skip") {
  setNow(value);
  flush();
  mounted = mount(
    Probe,
    {},
    fakeConvex({ query: (_name, args) => responses.get(JSON.stringify(args)) }),
  );
}

function update(value: number | "skip") {
  setNow(value);
  flush();
}

afterEach(() => {
  mounted?.unmount();
  responses.clear();
});

describe("useStableQuery", () => {
  it("keeps the last result while a changed argument has none yet", () => {
    const first: Value = { search: true };
    responses.set(JSON.stringify({ now: 1 }), first);
    render(1);
    expect(seen()).toEqual(first);

    // The tick: no result for the new args yet. A plain query says undefined.
    update(2);
    expect(seen()).toEqual(first);

    // The next tick has a result waiting: the hook moves on to it.
    const second: Value = { search: false };
    responses.set(JSON.stringify({ now: 3 }), second);
    update(3);
    expect(seen()).toEqual(second);
  });

  it("drops the held result while the query is skipped, and starts over after", () => {
    const first: Value = { search: true };
    responses.set(JSON.stringify({ now: 1 }), first);
    render(1);
    expect(seen()).toEqual(first);

    // Session gone: nothing from it may linger.
    update("skip");
    expect(seen()).toBeUndefined();

    // A new session with no result yet is "never loaded", not the old value.
    update(2);
    expect(seen()).toBeUndefined();

    const second: Value = { search: false };
    responses.set(JSON.stringify({ now: 3 }), second);
    update(3);
    expect(seen()).toEqual(second);
  });

  it("still reports undefined before anything has ever loaded", () => {
    render(1);
    expect(seen()).toBeUndefined();
  });
});
