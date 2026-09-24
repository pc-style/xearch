// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, flush } from "solid-js";
import { createAuthClient } from "../src/data/auth";

const ADDRESS = "https://example.convex.cloud";

const JWT_KEY = "__convexAuthJWT_httpsexampleconvexcloud";

function jwt(sub: string, iat: number): string {
  const encode = (value: Record<string, string | number>) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "");

  return `${encode({ alg: "none" })}.${encode({ sub, iat })}.sig`;
}

function otherTabWrites(value: string | null) {
  window.dispatchEvent(
    new StorageEvent("storage", { key: JWT_KEY, newValue: value, storageArea: localStorage }),
  );
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  localStorage.clear();
});

function start() {
  localStorage.setItem(JWT_KEY, jwt("user-1|session-1", 1));

  return createRoot((done) => {
    dispose = done;

    return createAuthClient({ address: ADDRESS, sync: { action: () => Promise.resolve(null) } });
  });
}

describe("createAuthClient cross-tab storage events", () => {
  it("takes another tab's refreshed token for the same subject without an identity change", async () => {
    const auth = start();
    flush();
    const before = auth.identity?.() ?? Number.NaN;

    otherTabWrites(jwt("user-1|session-1", 2));
    flush();

    expect(auth.identity?.()).toBe(before);
    expect(await auth.fetchAccessToken({ forceRefreshToken: false })).toBe(
      jwt("user-1|session-1", 2),
    );
  });

  it("treats a different subject or a sign-out in another tab as an identity change", () => {
    const auth = start();
    flush();
    const before = auth.identity?.() ?? Number.NaN;

    otherTabWrites(jwt("user-2|session-9", 3));
    flush();
    expect(auth.identity?.()).toBe(before + 1);

    otherTabWrites(null);
    flush();
    expect(auth.identity?.()).toBe(before + 2);
    expect(auth.isAuthenticated()).toBe(false);
  });
});
