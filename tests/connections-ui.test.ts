import { describe, expect, it } from "vitest";
import { receiverConnection } from "../src/integrationStatus";

/**
 * `convex/integrations.ts`'s `configured.handoff` means "the raw-capture
 * receiver env vars are set" in receiver mode, but "the download worker's
 * heartbeat is fresh" in outbound mode — a fact read from the `collector`
 * table, not from RAW_CAPTURE_URL/RAW_CAPTURE_TOKEN (those are read only by
 * the worker process on its own machine). The Connections panel row must
 * not tell a person to set env vars that the running deployment ignores.
 */
describe("the storage row in the Connections panel", () => {
  it("names the raw-capture receiver and its env vars in receiver mode", () => {
    const row = receiverConnection("receiver", false);
    expect(row.name).toBe("Raw capture receiver");
    expect(row.env).toBe("RAW_CAPTURE_URL, RAW_CAPTURE_TOKEN");
    expect(row.note).toBeUndefined();
  });

  it("names the download worker and gives no env vars in outbound mode", () => {
    const row = receiverConnection("outbound", true);
    expect(row.name).toBe("Download worker");
    expect(row.env).toBeUndefined();
    expect(row.note).toMatch(/on its own/);
    expect(row.note).not.toMatch(/RAW_CAPTURE/);
  });

  it("carries the live ready value through in both modes", () => {
    expect(receiverConnection("outbound", true).ready).toBe(true);
    expect(receiverConnection("outbound", false).ready).toBe(false);
    expect(receiverConnection("receiver", undefined).ready).toBeUndefined();
  });
});
