import { describe, expect, it } from "vitest";
import { indexingUnavailableMessage, OPERATOR_SIGN_IN_NOTICE } from "../src/integrationStatus";

describe("indexing availability guidance", () => {
  it("reports an offline worker in outbound mode", () => {
    expect(
      indexingUnavailableMessage({
        xmd: true,
        indexing: false,
        handoff: false,
        collectorMode: "outbound",
      }),
    ).toContain("download worker is offline");
  });

  it("reports a missing receiver only in receiver mode", () => {
    expect(
      indexingUnavailableMessage({
        xmd: true,
        indexing: false,
        handoff: false,
        collectorMode: "receiver",
      }),
    ).toContain("raw-capture receiver");
  });

  it("reports a missing x.md key before handoff status", () => {
    expect(
      indexingUnavailableMessage({
        xmd: false,
        indexing: false,
        handoff: false,
        collectorMode: "outbound",
      }),
    ).toContain("x.md key");
  });

  it("returns no warning when indexing is ready", () => {
    expect(
      indexingUnavailableMessage({
        xmd: true,
        indexing: true,
        handoff: true,
        collectorMode: "outbound",
      }),
    ).toBeUndefined();
  });
});

describe("operator notice", () => {
  // Tests import the operator build's `operatorBuild.ts` (no public alias).
  it("does not send someone already on the operator dashboard to it", () => {
    expect(OPERATOR_SIGN_IN_NOTICE).not.toContain("operator dashboard");
    expect(OPERATOR_SIGN_IN_NOTICE).toContain("operator token");
  });
});
