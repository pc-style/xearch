#!/usr/bin/env node
/**
 * Check search ranking against the constraints in docs/search-ranking.md.
 *
 * Samples random words and two-word phrases from the archived captures,
 * runs them and a fixed set of common queries through `xearch-search query -`
 * under both ranked sorts, and prints how many top-10 results break each
 * constraint. Read-only: it opens the index for searching and never writes.
 *
 *   node scripts/ranking-check.mjs --index=DIR --archive=DIR [--bin=PATH] [--verbose]
 *
 * --verbose also prints every violating result, for reading them.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { report, sample, violations } from "./lib/rankingCheck.mjs";

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const BASE = join(homedir(), "xearch-data/search");

const INDEX = arg("index", join(BASE, "index"));

const ARCHIVE = arg("archive", join(BASE, "archive"));

const BIN = arg("bin", join(import.meta.dirname, "../search/target/release/xearch-search"));

const VERBOSE = process.argv.includes("--verbose");

/** Each post's text once, from every retained capture. */
async function texts() {
  const seen = new Map();

  for (const name of await readdir(ARCHIVE)) {
    if (!name.endsWith(".json") || name.endsWith(".receipt.json")) continue;
    let capture;

    try {
      capture = JSON.parse(await readFile(join(ARCHIVE, name), "utf8"));
    } catch {
      continue;
    }

    for (const record of capture.records ?? [])
      for (const post of record.payload?.posts ?? [])
        if (post?.id && post.text) seen.set(post.id, String(post.text));
  }

  return [...seen.values()];
}

const groups = sample(await texts());

const queries = Object.values(groups).flat();

const results = new Map();

for (const sort of ["relevance", "engagement"]) {
  const run = spawnSync(BIN, ["--index", INDEX, "query", "-", "--sort", sort], {
    input: `${queries.join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });

  if (run.status !== 0) {
    console.error(run.stderr || run.error?.message);
    process.exit(1);
  }

  // One response per line; JSON escapes newlines, so splitting on them is safe.
  run.stdout
    .split("\n")
    .filter(Boolean)
    .forEach((line, index) => results.set(`${sort}\n${queries[index]}`, JSON.parse(line).rows));
}

if (VERBOSE)
  for (const sort of ["relevance", "engagement"])
    for (const query of queries)
      for (const { constraint, row, below } of violations(
        query,
        sort,
        results.get(`${sort}\n${query}`),
      ))
        console.log(
          `[${sort} ${constraint}] ${JSON.stringify(query)}: ${JSON.stringify(row.text.slice(0, 80))}` +
            (below ? ` above ${JSON.stringify(below.text.slice(0, 80))}` : ""),
        );

console.log(JSON.stringify(report(groups, results), null, 2));
