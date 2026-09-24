import { describe, expect, it, vi } from "vitest";
import { ProviderError, XmdClient } from "../convex/lib/xmd";

const profile = Response.json({ resource: "profile", profile: { id: "1", handle: "theo" } });

function keyOf(init?: RequestInit) {
  return new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "");
}

describe("x.md fallback key", () => {
  it("repeats a rate-limited request once with the fallback key", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      keyOf(init) === "primary"
        ? Response.json({ code: "rate_limited" }, { status: 429 })
        : profile.clone(),
    );

    const xmd = new XmdClient("primary", fetcher, "https://mdfromx.com", "fallback");

    await expect(xmd.read("profile", "theo")).resolves.toMatchObject({ resource: "profile" });
    expect(fetcher.mock.calls.map(([, init]) => keyOf(init))).toEqual(["primary", "fallback"]);
  });

  it("switches keys on a refused key but not on an answer any key would get", async () => {
    for (const status of [401, 402, 403]) {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
        keyOf(init) === "primary" ? new Response("", { status }) : profile.clone(),
      );

      await new XmdClient("primary", fetcher, "https://mdfromx.com", "fallback").read(
        "profile",
        "theo",
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    }

    const notFound = vi.fn<typeof fetch>(async () => new Response("", { status: 404 }));

    await expect(
      new XmdClient("primary", notFound, "https://mdfromx.com", "fallback").read("profile", "theo"),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("reports the fallback key's own failure when both are refused", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      keyOf(init) === "primary"
        ? new Response("", { status: 429 })
        : Response.json({ code: "quota_exhausted" }, { status: 402 }),
    );

    await expect(
      new XmdClient("primary", fetcher, "https://mdfromx.com", "fallback").read("profile", "theo"),
    ).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never sends the same key twice", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("", { status: 429 }));

    await new XmdClient("same", fetcher, "https://mdfromx.com", "same")
      .read("profile", "theo")
      .catch(() => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
