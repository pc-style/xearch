import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionGate, SESSION_TIMEOUT_MESSAGE } from "../src/sessionGate";

// Production had 18 anonymous users for one operator: every page load that
// saw a click before the client finished verifying its stored tokens minted a
// fresh identity, and with it an empty library.
describe("sessionGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not sign in while the client is still verifying stored credentials", async () => {
    const signIn = vi.fn(async () => {});
    const gate = createSessionGate(signIn);
    gate.update({ isLoading: true, isAuthenticated: false });
    const ensured = gate.ensure();
    await vi.advanceTimersByTimeAsync(0);
    expect(signIn).not.toHaveBeenCalled();
    // The stored identity turned out to be valid: nothing to create.
    gate.update({ isLoading: false, isAuthenticated: true });
    await expect(ensured).resolves.toBeUndefined();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("signs in only once the client has settled unauthenticated", async () => {
    const signIn = vi.fn(async () => {});
    const gate = createSessionGate(signIn);
    gate.update({ isLoading: true, isAuthenticated: false });
    const ensured = gate.ensure();
    gate.update({ isLoading: false, isAuthenticated: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(signIn).toHaveBeenCalledTimes(1);
    gate.update({ isLoading: false, isAuthenticated: true });
    await expect(ensured).resolves.toBeUndefined();
  });

  it("shares one sign-in between concurrent callers", async () => {
    const signIn = vi.fn(async () => {});
    const gate = createSessionGate(signIn);
    gate.update({ isLoading: false, isAuthenticated: false });
    const first = gate.ensure();
    const second = gate.ensure();
    await vi.advanceTimersByTimeAsync(0);
    gate.update({ isLoading: false, isAuthenticated: true });
    await Promise.all([first, second]);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op once authenticated", async () => {
    const signIn = vi.fn(async () => {});
    const gate = createSessionGate(signIn);
    gate.update({ isLoading: false, isAuthenticated: true });
    await gate.ensure();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("gives up with a clear message when the client never settles", async () => {
    const gate = createSessionGate(async () => {}, 1000);
    gate.update({ isLoading: true, isAuthenticated: false });
    const ensured = gate.ensure();
    const outcome = expect(ensured).rejects.toThrow(SESSION_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });
});
