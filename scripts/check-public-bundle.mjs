#!/usr/bin/env node
/**
 * Assert the public build is the client-facing app and nothing else.
 *
 * The dashboard and the Connections panel are excluded from this bundle by
 * `OPERATOR_BUILD` (src/operatorBuild.ts) folding to `false`, which lets
 * Rollup drop their dynamic imports as dead code. That is a property of the
 * bundler's tree shaking, not of anything TypeScript checks, so a refactor
 * that reintroduces a static import would silently put the operator UI back
 * on convex.site with every test still green. This looks at the emitted
 * files instead and fails the build if it finds operator-only text in them.
 *
 * Runs as part of `bun run build`, which is what the Convex static-hosting
 * deploy invokes — so an operator string cannot reach production without
 * this failing first.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DIST = process.argv[2] ?? "dist";

/** Text that exists only in operator-facing modules. */
const FORBIDDEN = [
  "AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID",
  "SEARCH_API_URL, SEARCH_SERVICE_TOKEN",
  "RAW_CAPTURE_URL, RAW_CAPTURE_TOKEN",
  "Dependency health",
  "Provider limits",
  "Account library",
];

const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:js|css|html)$/.test(entry.name)) files.push(path);
  }
}
await walk(DIST);
if (!files.length) {
  console.error(`check-public-bundle: no build output under ${DIST}/`);
  process.exit(1);
}

const found = [];
for (const path of files) {
  const text = await readFile(path, "utf8");
  for (const needle of FORBIDDEN) if (text.includes(needle)) found.push(`${path}: ${needle}`);
}
if (found.length) {
  console.error(
    "check-public-bundle: operator-only content is in the public bundle.\n" +
      found.map((f) => `  ${f}`).join("\n") +
      "\nThe dashboard and Connections panel must stay behind OPERATOR_BUILD's dynamic imports.",
  );
  process.exit(1);
}
console.log(`check-public-bundle: ${files.length} files clean.`);
