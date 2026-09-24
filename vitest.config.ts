import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,js}"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
