import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";

// Use once on a new local deployment; rotating these signs out existing sessions.
if (process.argv[2] !== "--local")
  throw new Error("Pass --local to configure this project's local deployment.");

const { readFileSync } = await import("node:fs");

if (!/^CONVEX_DEPLOYMENT=anonymous:/m.test(readFileSync(".env.local", "utf8")))
  throw new Error("Expected an anonymous local deployment.");

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const values = {
  JWT_PRIVATE_KEY: privateKey
    .export({ type: "pkcs8", format: "pem" })
    .trimEnd()
    .replace(/\n/g, " "),
  JWKS: JSON.stringify({
    keys: [{ use: "sig", ...publicKey.export({ format: "jwk" }) }],
  }),
  SITE_URL: "http://localhost:5173",
};

for (const [name, value] of Object.entries(values)) {
  const run = spawnSync("bunx", ["convex", "env", "set", name], {
    encoding: "utf8",
    input: value,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (run.status !== 0) throw new Error(`Could not set ${name}; inspect deployment configuration.`);
  console.log(`Configured ${name}; value not printed.`);
}
