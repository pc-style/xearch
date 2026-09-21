import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Which of the two sites this build produces. The public one — the default,
// and what Convex static hosting deploys — resolves `./operatorSurface` to a
// stub that imports nothing, so the dashboard and the Connections panel are
// absent from its module graph rather than merely unreachable inside it.
// See src/operatorSurface.ts.
const operator = process.env.VITE_XEARCH_OPERATOR === "1";

export default defineConfig({
  plugins: [
    react({
      compiler: { target: "19" },
    }),
  ],
  resolve: {
    alias: operator
      ? []
      : [
          {
            find: /^\.\/operatorSurface$/,
            replacement: fileURLToPath(new URL("./src/operatorSurface.public.ts", import.meta.url)),
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
