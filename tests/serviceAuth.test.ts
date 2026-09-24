import { describe, expect, it } from "vitest";
import { serviceToken } from "../convex/lib/serviceAuth";

describe("service capability credentials", () => {
  it("selects the dedicated capability instead of the legacy credential", () => {
    const env = {
      SEARCH_SERVICE_TOKEN: "read",
      RAW_CAPTURE_TOKEN: "ingest",
      DATA_SERVICE_TOKEN: "legacy",
    };

    expect(serviceToken("search", env)).toBe("read");
    expect(serviceToken("capture", env)).toBe("ingest");
  });
  it("never borrows the other capability's token", () => {
    expect(serviceToken("search", { RAW_CAPTURE_TOKEN: "ingest" })).toBeUndefined();
    expect(serviceToken("capture", { SEARCH_SERVICE_TOKEN: "read" })).toBeUndefined();
  });
  it("supports the existing shared credential only as an explicit legacy fallback", () => {
    expect(serviceToken("search", { DATA_SERVICE_TOKEN: "legacy" })).toBe("legacy");
    expect(serviceToken("capture", { DATA_SERVICE_TOKEN: "legacy" })).toBe("legacy");
    expect(
      serviceToken("capture", {
        RAW_CAPTURE_TOKEN: "",
        DATA_SERVICE_TOKEN: "legacy",
      }),
    ).toBe("");
  });
});
