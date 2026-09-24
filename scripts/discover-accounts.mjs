#!/usr/bin/env node
/**
 * Expand the indexed accounts to the people they interact with most.
 *
 * Reads the raw captures already on this machine (no provider is contacted),
 * counts replies, quotes, @mentions and reposts from indexed accounts per
 * target handle, and queues an account-history import for every target at or
 * above DISCOVERY_MIN_INTERACTIONS (default 100) that is neither indexed nor already the
 * subject of a bulk import. The threshold is the relevance criterion; there
 * is deliberately no per-run cap (AGENTS.md "Rate limiting").
 *
 *   node scripts/discover-accounts.mjs            # rank only, start nothing
 *   node scripts/discover-accounts.mjs --apply    # queue the imports
 *
 * Talks to Convex through `convex run` on internal functions, so it needs the
 * deploy key the VM already uses (CONVEX_DEPLOYMENT in the environment) and
 * neither a browser session nor the operator token.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { postsInCapture, rankInteractions } from "./lib/discovery.mjs";

const DIR =
  process.argv.find((a) => a.startsWith("--dir="))?.slice(6) ??
  join(homedir(), "xearch-data/.local-captures/raw");

const APPLY = process.argv.includes("--apply");

const MIN = Number(process.env.DISCOVERY_MIN_INTERACTIONS ?? "100");

if (!Number.isFinite(MIN) || MIN < 1) throw new Error("DISCOVERY_MIN_INTERACTIONS must be >= 1.");

// The checkout's own Convex CLI, run by the node already running this
// script: the systemd unit sets no PATH, so `npx` may not be found, and
// `npx` could otherwise try to download a package in an unattended run.
const CONVEX_CLI = fileURLToPath(new URL("../node_modules/convex/bin/main.js", import.meta.url));

function convexRun(fn, args) {
  const run = spawnSync(process.execPath, [CONVEX_CLI, "run", fn, JSON.stringify(args ?? {})], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  });

  if (run.error) throw new Error(`convex run ${fn} could not run: ${run.error.message}`);

  if (run.status !== 0) throw new Error(`convex run ${fn} failed: ${(run.stderr ?? "").trim()}`);

  return JSON.parse(run.stdout);
}

if (!process.env.CONVEX_DEPLOYMENT) {
  console.error("Set CONVEX_DEPLOYMENT so this cannot land on the wrong deployment.");
  process.exit(2);
}

const state = convexRun("jobs:discoveryState");

if (APPLY && state.truncated) {
  console.error(
    "Discovery state is truncated (too many indexed accounts or jobs); refusing --apply.",
  );
  process.exit(1);
}

const posts = [];

const seenPostIds = new Set();

for (const name of await readdir(DIR)) {
  if (!name.endsWith(".json")) continue;

  try {
    // A retry can save an acknowledged capture and requeue the same page
    // under a different `attempt`, so the same post can appear in more than
    // one capture file. Count it once, by its own id.
    for (const post of postsInCapture(JSON.parse(await readFile(join(DIR, name), "utf8")))) {
      const id = post?.id;

      if (id !== undefined) {
        if (seenPostIds.has(String(id))) continue;
        seenPostIds.add(String(id));
      }

      posts.push(post);
    }
  } catch (cause) {
    console.error(`skipping ${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const ranked = rankInteractions(posts, {
  indexed: state.indexed,
  exclude: state.existingInputs,
  minInteractions: MIN,
});

console.log(
  `${posts.length} posts from ${state.indexed.length} indexed accounts; ${ranked.length} account(s) at >= ${MIN} interactions.`,
);

for (const entry of ranked) {
  const via = entry.discoveredFrom
    .slice(0, 3)
    .map((f) => `@${f.handle} ${f.interactions}`)
    .join(", ");

  console.log(
    `  @${entry.handle.padEnd(16)} ${String(entry.interactions).padStart(5)}  via ${via}`,
  );
}

if (!APPLY) {
  console.log("\nNothing started. Re-run with --apply to queue these imports.");
  process.exit(0);
}

let started = 0;

for (const entry of ranked) {
  const id = convexRun("jobs:startDiscovered", {
    input: entry.handle,
    // Every source, so the stored list sums to the interactions that caused
    // this import; bounded by the number of indexed accounts.
    discoveredFrom: entry.discoveredFrom,
  });

  if (id) started += 1;
}

console.log(`\nQueued ${started} import(s) on ${process.env.CONVEX_DEPLOYMENT}.`);
