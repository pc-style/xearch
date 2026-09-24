#!/usr/bin/env node
/**
 * Recover `accounts` rows from raw captures already on this machine.
 *
 * Reads the subject profile out of every retained capture, keeps the newest
 * one per handle, and hands them to `backfill:accountsFromProfiles`. No
 * provider is contacted and nothing is spent — these bytes were paid for
 * when the import ran. See convex/backfill.ts for why they are missing.
 *
 *   node scripts/backfill-accounts.mjs                 # show what it found
 *   CONVEX_DEPLOYMENT=prod:… node scripts/backfill-accounts.mjs --apply
 *
 * Only `payload.profile` is read: that is the account the request was *for*.
 * Post authors inside a live-search payload are deliberately not harvested —
 * they would invent library rows for accounts nobody imported.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const DIR =
  process.argv.find((a) => a.startsWith("--dir="))?.slice(6) ??
  join(homedir(), "xearch-data/.local-captures/raw");

const APPLY = process.argv.includes("--apply");

// The same shape and the same validation convex/importer.ts and
// scripts/production-worker.ts apply, so a backfilled row is indistinguishable
// from one the live path would have written.
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const newest = new Map();

for (const name of await readdir(DIR)) {
  if (!name.endsWith(".json")) continue;
  let capture;

  try {
    capture = JSON.parse(await readFile(join(DIR, name), "utf8"));
  } catch {
    console.warn(`skipped unreadable capture: ${name}`);
    continue;
  }

  for (const record of capture.records ?? []) {
    const profile = record?.payload?.profile;
    const screenName = profile?.screen_name;

    if (typeof screenName !== "string" || !HANDLE.test(screenName)) continue;

    if (profile.id === undefined || profile.id === null) continue;
    const handle = screenName.toLowerCase();
    const at = record.receivedAt ?? 0;

    if ((newest.get(handle)?.at ?? -1) >= at) continue;
    const avatar = profile.avatar_url;
    newest.set(handle, {
      at,
      profile: {
        handle,
        userId: String(profile.id),
        name: typeof profile.name === "string" && profile.name ? profile.name : screenName,
        ...(typeof avatar === "string" && avatar.startsWith("https://") ? { avatar } : {}),
      },
    });
  }
}

const profiles = [...newest.values()].map((v) => v.profile);

profiles.sort((a, b) => a.handle.localeCompare(b.handle));

console.log(`${profiles.length} account profiles recovered from ${DIR}`);

for (const p of profiles) console.log(`  ${p.handle.padEnd(18)} ${p.userId}`);

if (!APPLY) {
  console.log("\nNothing written. Re-run with --apply to send these to the deployment.");
  process.exit(0);
}

if (!process.env.CONVEX_DEPLOYMENT) {
  console.error("Set CONVEX_DEPLOYMENT so this cannot land on the wrong deployment.");
  process.exit(1);
}

console.log(`\nApplying to ${process.env.CONVEX_DEPLOYMENT} …`);

const run = spawnSync(
  "bunx",
  ["convex", "run", "backfill:accountsFromProfiles", JSON.stringify({ profiles })],
  { stdio: "inherit" },
);

process.exit(run.status ?? 1);
