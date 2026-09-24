import { describe, expect, it } from "vitest";
import { redactEmail as redactBrowserEmail } from "../src/posthog";
import { redactEmail as redactBackendEmail, sanitizeError } from "../convex/lib/posthog";

describe.each([redactBrowserEmail, redactBackendEmail])(
  "PostHog email redaction",
  (redactEmail) => {
    it("keeps search context while removing addresses from queries and URLs", () => {
      expect(redactEmail("from:Adam@Example.com local-first")).toBe("from:[email] local-first");
      expect(redactEmail("https://x.com/search?q=adam%40example.com&sort=latest")).toBe(
        "https://x.com/search?q=[email]&sort=latest",
      );
    });
  },
);

it("removes URLs and credentials from import diagnostics", () => {
  expect(
    sanitizeError("GET https://api.example.com/path?token=secret failed for a@b.com; Bearer abc"),
  ).toBe("GET [url] failed for [email]; Bearer [redacted]");
});
