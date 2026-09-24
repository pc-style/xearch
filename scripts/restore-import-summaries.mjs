import { readdir, readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const env = parseEnv(await readFile(".env.local", "utf8"));

if (!env.CONVEX_DEPLOYMENT?.startsWith("anonymous:")) throw new Error("Local deployment only");

let checked = 0;

for (const filename of await readdir(".local-captures/raw")) {
  if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
  const bytes = await readFile(`.local-captures/raw/${filename}`);
  const capture = JSON.parse(bytes);

  if (
    capture.source !== "x-md" ||
    capture.request?.resource !== "bulk" ||
    capture.terminal !== "complete"
  )
    continue;

  const payload = capture.records.find(
    (record) => Array.isArray(record.payload?.posts) && record.payload.meta,
  )?.payload;

  if (!payload) continue;

  const args = {
    jobId: capture.runId,
    captureId: createHash("sha256").update(bytes).digest("hex"),
    posts: payload.posts.length,
    oldest: typeof payload.meta.oldest === "string" ? payload.meta.oldest : undefined,
    floorReached: payload.meta.floor_reached === true,
  };

  const result = spawnSync("bunx", ["convex", "run", "jobs:restoreSummary", JSON.stringify(args)], {
    encoding: "utf8",
  });

  if (result.status !== 0)
    throw new Error("Could not restore an import summary. Existing data was not deleted.");
  checked++;
}

console.log(`Checked ${checked} saved history batches for missing display statistics.`);
