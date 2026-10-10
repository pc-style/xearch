#!/usr/bin/env node
/**
 * Walk again only the history the old backfill skipped.
 *
 * Before `resumeUntil` (convex/lib/historyWindow.ts), every history window
 * that x.md stopped paging early left the rest of its range unfetched, so
 * each backfilled account has holes. This reads the retained captures on
 * this machine (no provider is contacted), works out per account which
 * date ranges no capture covers (scripts/lib/backfillGaps.mjs), and with
 * --apply restarts each account's backfill over just those ranges, newest
 * first. Applying spends x.md search allowance.
 *
 *   node scripts/backfill-gaps.mjs                          # show the holes
 *   node scripts/backfill-gaps.mjs --exclude=theo --apply   # walk them
 *
 * The archive and Convex access can live on different machines: `--json`
 * prints the plan, and `--from=plan.json` reads it instead of the archive.
 *
 *   node scripts/backfill-gaps.mjs --exclude=theo --json > plan.json   # on the VM
 *   CONVEX_DEPLOYMENT=prod:… node scripts/backfill-gaps.mjs --from=plan.json --apply
 *
 * Talks to Convex through `convex run`, so it needs the deployment the VM
 * already uses (CONVEX_DEPLOYMENT in the environment).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { addCapture, covered, gaps } from "./lib/backfillGaps.mjs";

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const ARCHIVE = arg("archive", join(homedir(), "xearch-data/search/archive"));

const EXCLUDE = new Set(
  arg("exclude", "")
    .split(",")
    .filter(Boolean)
    .map((handle) => handle.toLowerCase()),
);

const APPLY = process.argv.includes("--apply");

const JSON_OUT = process.argv.includes("--json");

const FROM = arg("from", "");

/** X's launch: the walk goes no further back (the server stops at each account's join date). */
const FLOOR = "2006-03-21";

const CONVEX_CLI = fileURLToPath(new URL("../node_modules/convex/bin/main.js", import.meta.url));

/** Each account's ranges no capture covers, newest first. */
async function plan() {
  const accounts = new Map();

  for (const name of await readdir(ARCHIVE)) {
    if (!name.endsWith(".json") || name.endsWith(".receipt.json")) continue;
    let capture;

    try {
      capture = JSON.parse(await readFile(join(ARCHIVE, name), "utf8"));
    } catch {
      continue;
    }

    addCapture(accounts, capture);
  }

  return (
    [...accounts]
      // Only accounts a backfill has walked have holes of this kind.
      .filter(([handle, account]) => account.windows.size && !EXCLUDE.has(handle))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([handle, account]) => ({ handle, ranges: gaps(covered(account), FLOOR) }))
  );
}

const accounts = FROM ? JSON.parse(await readFile(FROM, "utf8")) : await plan();

if (JSON_OUT) {
  console.log(JSON.stringify(accounts, null, 1));
  process.exit(0);
}

let failed = 0;

for (const { handle, ranges } of accounts) {
  if (EXCLUDE.has(handle)) continue;

  const days = ranges.reduce(
    (total, { since, until }) => total + (Date.parse(until) - Date.parse(since)) / 86_400_000,
    0,
  );

  console.log(
    `${handle}: ${ranges.length} range(s), ${Math.round(days)} days` +
      (ranges.length ? ` — ${ranges.map((r) => `${r.since}..${r.until}`).join(", ")}` : ""),
  );

  if (!APPLY || !ranges.length) continue;

  const run = spawnSync(
    process.execPath,
    [CONVEX_CLI, "run", "jobs:restartHistoryBackfill", JSON.stringify({ handle, ranges })],
    { encoding: "utf8" },
  );

  if (run.status !== 0) {
    failed++;
    console.error(
      `  not restarted: ${(run.stderr || run.error?.message || "").trim().split("\n").at(-1)}`,
    );
  } else console.log("  restarted");
}

if (failed) process.exitCode = 1;
