import { describe, expect, it } from "vitest";
import { createTaskRunner } from "../src/errors";

/**
 * Several buttons call `run` without disabling themselves first, so two runs
 * can share one busy/message pair. Both failures asserted here were true of
 * every hand-rolled copy of this pattern before it was consolidated.
 */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function spies() {
  const busy: boolean[] = [];
  const messages: string[] = [];

  return {
    busy,
    messages,
    setBusy: (value: boolean) => busy.push(value),
    setMessage: (value: string) => messages.push(value),
    get isBusy() {
      return busy.at(-1) ?? false;
    },
    get message() {
      return messages.at(-1) ?? "";
    },
  };
}

describe("overlapping runs share one busy flag", () => {
  it("keeps busy raised until every run has finished, not just the first", async () => {
    const seen = spies();
    const run = createTaskRunner(seen.setBusy, seen.setMessage);
    const first = deferred();
    const second = deferred();

    const a = run(() => first.promise);
    const b = run(() => second.promise);
    expect(seen.isBusy).toBe(true);

    // The first finishing must not clear the spinner out from under the
    // second, which is still working.
    first.resolve();
    await a;
    expect(seen.isBusy).toBe(true);

    second.resolve();
    await b;
    expect(seen.isBusy).toBe(false);
  });

  it("does not let an earlier run's failure overwrite a later run's result", async () => {
    const seen = spies();
    const run = createTaskRunner(seen.setBusy, seen.setMessage);
    const early = deferred();
    const late = deferred();

    const a = run(() => early.promise);
    const b = run(() => late.promise, "Saved.");

    // The later run reports first.
    late.resolve();
    await b;
    expect(seen.message).toBe("Saved.");

    // Then the earlier one fails. Its error is stale and must not land.
    early.reject(new Error("an old failure"));
    await a;
    expect(seen.message).toBe("Saved.");
  });

  it("still clears busy when a stale run finishes last, rather than leaking the count", async () => {
    const seen = spies();
    const run = createTaskRunner(seen.setBusy, seen.setMessage);
    let alive = true;
    const stale = deferred();

    const a = run(() => stale.promise, { alive: () => alive });
    alive = false;
    stale.resolve();
    await a;

    // Nothing is in flight, so the spinner must come down even though the
    // run that finished had gone stale.
    expect(seen.isBusy).toBe(false);
  });
});
