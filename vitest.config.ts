import { defineConfig } from "vitest/config";
import stylex from "@stylexjs/unplugin";
export default defineConfig({
  plugins: [stylex.vite({ dev: true })],
  test: {
    include: ["tests/**/*.test.{ts,js}"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
