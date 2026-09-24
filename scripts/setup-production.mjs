import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";

const deployment = "utmost-kudu-321";

const env = parseEnv(await readFile(".env.local", "utf8"));

const values = { SITE_URL: `https://${deployment}.convex.site`, REQUIRE_VERIFIED_EMAIL: "true" };

// Never copy localhost receiver URLs, local auth keys, or local capture credentials.
for (const name of [
  "X_MD_API_KEY",
  "X_MD_BASE_URL",
  "FIRECRAWL_API_KEY",
  "POSTHOG_PROJECT_TOKEN",
  "POSTHOG_HOST",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
]) {
  if (env[name]?.trim()) values[name] = env[name];
}

if (process.argv.includes("--init-auth")) {
  const existing = spawnSync("bunx", ["convex", "env", "get", "JWKS", "--deployment", deployment], {
    encoding: "utf8",
  });

  if (existing.stdout.trim()) throw new Error("Auth keys already exist; refusing to rotate them.");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  values.JWT_PRIVATE_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .trimEnd()
    .replace(/\n/g, " ");
  values.JWKS = JSON.stringify({ keys: [{ use: "sig", ...publicKey.export({ format: "jwk" }) }] });
}

for (const [name, value] of Object.entries(values)) {
  const result = spawnSync("bunx", ["convex", "env", "set", name, "--deployment", deployment], {
    input: value + "\n",
    encoding: "utf8",
  });

  if (result.status !== 0)
    throw new Error(`Could not configure ${name}. Secret output suppressed.`);
  console.log(`Configured production ${name}`);
}
