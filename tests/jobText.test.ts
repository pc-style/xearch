import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { inlineImportStatus } from "../src/jobText";

function jobId(id: string) {
  // SAFETY: `Id<"jobs">` is `string & { __tableName: "jobs" }`, a subtype of
  // `string`; this fixture helper attaches that brand to a test-authored id.
  return id as Id<"jobs">;
}

function userId(id: string) {
  // SAFETY: `Id<"users">` is `string & { __tableName: "users" }`, a subtype
  // of `string`; this fixture helper attaches that brand to a test-authored
  // id.
  return id as Id<"users">;
}

function job(overrides: Partial<Doc<"jobs">>): Doc<"jobs"> {
  const base = {
    _id: jobId("job-1"),
    _creationTime: 0,
    owner: userId("user-1"),
    kind: "post" as const,
    input: "https://x.com/theo/status/1",
    refresh: false,
    status: "queued" as const,
    count: 0,
    attempt: 0,
    warnings: [],
    updatedAt: 0,
    ...overrides,
  };

  // SAFETY: `base` covers every required field of `Doc<"jobs">` (the fixture
  // literal above lists them all); `overrides` only ever narrows optional or
  // same-shaped fields, so this is a plain upcast to the full document type,
  // not a lie about its shape.
  return base as Doc<"jobs">;
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
