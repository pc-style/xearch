import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,js}"],
    setupFiles: ["./tests/setupEnv.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
