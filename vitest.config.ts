import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";

// Tests that mount Solid components. The Solid plugin picks its posture per
// vitest project from `test.environment`: jsdom gets DOM codegen and Solid's
// browser build, node gets server codegen — so the rendered tests need a
// project of their own rather than a per-file environment comment.
const DOM_TESTS = [
  "tests/**/*-ui.test.{ts,tsx}",
  "tests/coderabbit-pr46-results-section.test.ts",
  "tests/coderabbit-pr46-round2.test.ts",
  "tests/results-section-*.test.ts",
  "tests/scenario-provider-throttling.test.ts",
  "tests/scenario-publication-lifecycle.test.ts",
  "tests/scenario-screenshot-cases.test.ts",
  "tests/signed-out-states.test.ts",
];

const shared = {
  setupFiles: ["./tests/setupEnv.ts"],
  server: { deps: { inline: ["convex-test"] } },
};

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.{ts,tsx,js}"],
          exclude: DOM_TESTS,
        },
      },
      {
        extends: true,
        plugins: [solid()],
        test: { ...shared, name: "dom", environment: "jsdom", include: DOM_TESTS },
      },
    ],
  },
});
