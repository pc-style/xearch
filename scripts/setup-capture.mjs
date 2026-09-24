import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const config = await readFile(".env.local", "utf8");

if (!/^CONVEX_DEPLOYMENT=anonymous:/m.test(config))
  throw new Error("This setup is restricted to the existing anonymous local Convex deployment.");

await mkdir(".local-captures", { recursive: true, mode: 0o700 });

let token;

try {
  token = (await readFile(".local-captures/token", "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  token = randomBytes(32).toString("hex");
  await writeFile(".local-captures/token", token, { mode: 0o600, flag: "wx" });
}

for (const [name, value] of Object.entries({
  RAW_CAPTURE_TOKEN: token,
  RAW_CAPTURE_URL: "http://127.0.0.1:4319/captures",
})) {
  const result = spawnSync("bunx", ["convex", "env", "set", name], {
    input: `${value}\n`,
    encoding: "utf8",
  });

  if (result.status !== 0)
    throw new Error(`Could not configure ${name}; provider output suppressed.`);
  console.log(`Configured ${name} locally.`);
}
