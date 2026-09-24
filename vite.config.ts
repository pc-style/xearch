import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import posthog from "@posthog/rollup-plugin";

// Which of the two sites this build produces. The public one — the default,
// and what Convex static hosting deploys — resolves `./operatorSurface` to a
// stub that imports nothing, so the dashboard and the Connections panel are
// absent from its module graph rather than merely unreachable inside it.
// See src/operatorSurface.ts.
const operator = process.env.VITE_XEARCH_OPERATOR === "1";

// Matches a relative specifier for `name` regardless of how many `../`
// segments got it there — `./operatorToken` from a file in `src/`, but also
// `../operatorToken` from `src/library/AccountRow.tsx` (CodeRabbit
// #4090910250: the original `/^\.\/name$/` only ever matched the first, so a
// deeper importer would have pulled in the real, un-swapped module). Each
// `(\.\.?\/)` group matches one `./` or `../` path segment; `+` allows any
// depth. Still anchored start-to-end, so it can't partially match something
// like `./operatorTokenFoo`.
// Exported so tests/vite-config.test.ts can assert its matching behavior
// directly — vite.config.ts itself isn't imported by the app, so this is
// the only way to unit-test the regex without a full build.
export function relativeModule(name: string): RegExp {
  return new RegExp(`^(\\.\\.?/)+${name}$`);
}

export default defineConfig({
  plugins: [
    react({
      compiler: { target: "19" },
    }),
    ...(process.env.POSTHOG_CLI_API_KEY &&
    process.env.POSTHOG_CLI_PROJECT_ID &&
    process.env.POSTHOG_CLI_HOST
      ? [
          posthog({
            personalApiKey: process.env.POSTHOG_CLI_API_KEY,
            projectId: process.env.POSTHOG_CLI_PROJECT_ID,
            host: process.env.POSTHOG_CLI_HOST,
            sourcemaps: { enabled: true, deleteAfterUpload: true },
          }),
        ]
      : []),
  ],
  resolve: {
    alias: operator
      ? []
      : [
          {
            find: relativeModule("operatorSurface"),
            replacement: fileURLToPath(new URL("./src/operatorSurface.public.ts", import.meta.url)),
          },
          {
            find: relativeModule("operatorBuild"),
            replacement: fileURLToPath(new URL("./src/operatorBuild.public.ts", import.meta.url)),
          },
          {
            find: relativeModule("operatorToken"),
            replacement: fileURLToPath(new URL("./src/operatorToken.public.ts", import.meta.url)),
          },
        ],
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    // The exe.dev proxy forwards the public hostname through as Host; vite
    // rejects hostnames it does not know, which shows up as a blank page.
    allowedHosts: [".exe.xyz"],
  },
});
