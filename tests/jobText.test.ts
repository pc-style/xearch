import { describe, expect, it } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import { inlineImportStatus } from "../src/jobText";

function job(overrides: Partial<Doc<"jobs">>): Doc<"jobs"> {
  return {
    _id: "job-1" as Doc<"jobs">["_id"],
    _creationTime: 0,
    owner: "user-1" as Doc<"jobs">["owner"],
    kind: "post",
    input: "https://x.com/theo/status/1",
    refresh: false,
    status: "queued",
    count: 0,
    attempt: 0,
    warnings: [],
    updatedAt: 0,
    ...overrides,
  } as Doc<"jobs">;
}

describe("inlineImportStatus", () => {
  it("returns null when there is no job yet", () => {
    expect(inlineImportStatus(undefined)).toBeNull();
  });

  it("reports a waiting state for queued jobs, distinct from downloading", () => {
    expect(inlineImportStatus(job({ status: "queued" }))).toBe(
      "Waiting to download from X… Progress appears in Recent imports.",
    );
  });

  it("reports an in-flight download for running jobs", () => {
    expect(inlineImportStatus(job({ status: "running", phase: "Saving raw capture" }))).toBe(
      "Downloading from X… Progress appears in Recent imports.",
    );
  });

  it("reports a completed job with the job's own summary", () => {
    expect(inlineImportStatus(job({ status: "complete" }))).toBe(
      "Downloaded — Response saved. See Recent imports for details.",
    );
  });

  it("reports a failed job with its error", () => {
    expect(
      inlineImportStatus(
        job({ status: "failed", error: "x.md could not finish this request (400)" }),
      ),
    ).toBe("Failed — x.md could not finish this request (400). See Recent imports for details.");
  });

  it("does not add a redundant period when the detail already ends a sentence", () => {
    expect(inlineImportStatus(job({ status: "failed", error: "The request timed out." }))).toBe(
      "Failed — The request timed out. See Recent imports for details.",
    );
  });
});
