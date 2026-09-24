import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  dedupeJobsByInput,
  inlineImportStatus,
  isPermanentFailure,
  jobKindLabel,
  relativeTime,
} from "../src/jobText";

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

describe("jobKindLabel", () => {
  it("labels a bulk job by the account it downloads, not the raw kind", () => {
    expect(jobKindLabel(job({ kind: "bulk", input: "theo" }))).toBe("@theo history");
  });

  it("recovers the handle from a post job's status URL", () => {
    expect(jobKindLabel(job({ kind: "post", input: "https://x.com/theo/status/123" }))).toBe(
      "Conversation on @theo's post",
    );
  });

  it("falls back to a generic label for a post job with an unparseable input", () => {
    expect(jobKindLabel(job({ kind: "post", input: "not-a-url" }))).toBe("Conversation on a post");
  });

  it("labels a live-search job with the query itself", () => {
    expect(jobKindLabel(job({ kind: "live", input: "@theo convex" }))).toBe(
      "Live search: @theo convex",
    );
  });
});

describe("isPermanentFailure", () => {
  it("is true only for a stopped job explicitly marked non-retryable", () => {
    expect(isPermanentFailure(job({ status: "failed", retryable: false }))).toBe(true);
    expect(isPermanentFailure(job({ status: "partial", retryable: false }))).toBe(true);
  });

  it("is false for a transient failure, an unclassified one, and any non-stopped job", () => {
    expect(isPermanentFailure(job({ status: "failed", retryable: true }))).toBe(false);
    expect(isPermanentFailure(job({ status: "failed" }))).toBe(false);
    expect(isPermanentFailure(job({ status: "cancelled", retryable: false }))).toBe(false);
    expect(isPermanentFailure(job({ status: "queued", retryable: false }))).toBe(false);
  });
});

describe("relativeTime", () => {
  it("reports coarser units the further back the timestamp is", () => {
    const now = 1_000_000;
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5d ago");
  });
});

describe("dedupeJobsByInput", () => {
  it("keeps only the first (newest) run per kind+input and counts the rest", () => {
    const newest = job({ _id: jobId("job-3"), kind: "bulk", input: "theo" });

    const rows = dedupeJobsByInput([
      newest,
      job({ _id: jobId("job-2"), kind: "bulk", input: "theo" }),
      job({ _id: jobId("job-1"), kind: "bulk", input: "theo" }),
      job({ _id: jobId("job-0"), kind: "live", input: "convex" }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.job).toBe(newest);
    expect(rows[0]!.earlierCount).toBe(2);
    expect(rows[1]!.earlierCount).toBe(0);
  });
});
