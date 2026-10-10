import { describe, expect, it } from "vitest";
import {
  addCapture,
  covered,
  gaps,
  type Account,
  type Capture,
} from "../scripts/lib/backfillGaps.mjs";

function window(
  runId: string,
  since: string,
  until: string,
  posts: string[],
  terminal = "complete",
): Capture {
  return {
    runId,
    terminal,
    request: { resource: "live", input: `from:theo since:${since} until:${until}` },
    records: [{ payload: { posts: posts.map((created_at) => ({ created_at })) } }],
  };
}

function account(...captures: Capture[]): Account {
  const accounts = new Map<string, Account>();

  for (const capture of captures) addCapture(accounts, capture);

  return accounts.get("theo")!;
}

describe("backfill gaps", () => {
  it("finds what a window x.md stopped paging early left behind", () => {
    // Production: a year asked for, Sep to Nov 2022 returned.
    const theo = account(
      window("a", "2021-11-02", "2022-11-02", ["Wed Sep 28 20:43:31 +0000 2022"]),
      window("a", "2021-11-02", "2022-11-02", ["Fri Oct 07 00:07:03 +0000 2022"]),
      window("b", "2022-11-02", "2023-11-02", ["2023-07-04T01:25:44Z"]),
    );

    expect(gaps(covered(theo), "2021-11-02")).toEqual([
      { since: "2022-11-02", until: "2023-07-04" },
      { since: "2021-11-02", until: "2022-09-28" },
    ]);
  });

  it("counts a finished empty window as covered but not a failed one", () => {
    const quiet = account(
      window("a", "2010-01-01", "2011-01-01", []),
      window("b", "2011-01-01", "2012-01-01", [], "partial"),
      window("c", "2012-01-01", "2013-01-01", ["2012-01-05T00:00:00Z"]),
    );

    expect(gaps(covered(quiet), "2010-01-01")).toEqual([
      { since: "2011-01-01", until: "2012-01-05" },
    ]);
  });

  it("covers a timeline's run of posts but not a pinned post months before it", () => {
    const theo = account(window("a", "2026-03-01", "2026-03-31", ["2026-03-02T00:00:00Z"]), {
      request: { resource: "bulk", input: "Theo" },
      records: [
        {
          payload: {
            posts: [
              { created_at: "2026-09-24T00:00:00Z" },
              { created_at: "2026-09-01T00:00:00Z" },
              { created_at: "2026-08-10T00:00:00Z" },
              { created_at: "2026-07-20T00:00:00Z" },
              { created_at: "2026-07-11T00:00:00Z" },
              { created_at: "2026-03-30T00:00:00Z" },
            ],
          },
        },
      ],
    });

    expect(gaps(covered(theo), "2026-03-02")).toEqual([
      { since: "2026-03-31", until: "2026-07-11" },
    ]);
  });

  it("joins holes less than a week apart into one range", () => {
    const spans = [
      { since: "2020-01-05", until: "2020-01-08" },
      { since: "2020-01-10", until: "2020-02-01" },
      { since: "2020-03-01", until: "2020-04-01" },
    ];

    expect(gaps(spans, "2020-01-01")).toEqual([
      { since: "2020-02-01", until: "2020-03-01" },
      { since: "2020-01-01", until: "2020-01-10" },
    ]);
  });
});
