import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

const env = parseEnv(await readFile(".env.local", "utf8"));

if (!env.CONVEX_DEPLOYMENT?.startsWith("anonymous:"))
  throw new Error("This script only syncs the local anonymous deployment.");

const allowed = [
  "X_MD_API_KEY",
  "X_MD_BASE_URL",
  "FIRECRAWL_API_KEY",
  "POSTHOG_PROJECT_TOKEN",
  "POSTHOG_HOST",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
  "AGENTMAIL_WEBHOOK_SECRET",
  "RAW_CAPTURE_URL",
  "RAW_CAPTURE_TOKEN",
  "SEARCH_API_URL",
  "SEARCH_SERVICE_TOKEN",
  "DATA_SERVICE_TOKEN",
];

// The component requires these values, but local activity must never reach PostHog.
const localOnly = {
  POSTHOG_PROJECT_TOKEN: "disabled",
  POSTHOG_HOST: "https://eu.i.posthog.com",
};

for (const name of allowed) {
  const value = name in localOnly ? localOnly[name] : env[name];

  if (!value?.trim()) continue;

  const result = spawnSync("bunx", ["convex", "env", "set", name], {
    input: `${value}\n`,
    encoding: "utf8",
  });

  if (result.status !== 0)
    throw new Error(`Sync failed for ${name}. Output suppressed to protect secrets.`);
  console.log(`Synced ${name}`);
}
