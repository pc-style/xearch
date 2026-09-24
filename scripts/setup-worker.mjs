import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

await mkdir(".local-captures", { recursive: true, mode: 0o700 });

let token;

try {
  token = (await readFile(".local-captures/worker-token", "utf8")).trim();
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  token = randomBytes(32).toString("hex");
  await writeFile(".local-captures/worker-token", token, {
    mode: 0o600,
    flag: "wx",
  });
}

for (const [name, value] of Object.entries({
  COLLECTOR_TOKEN: token,
  COLLECTOR_MODE: "outbound",
})) {
  const result = spawnSync(
    "bunx",
    ["convex", "env", "set", name, "--deployment", "utmost-kudu-321"],
    { input: value + "\n", encoding: "utf8" },
  );

  if (result.status !== 0)
    throw new Error(`Could not configure ${name}. Secret output suppressed.`);
  console.log(`Configured production ${name}`);
}
