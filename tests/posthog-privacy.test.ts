import { describe, expect, it } from "vitest";
import { redactEmail as redactBrowserEmail, sanitizeException } from "../src/posthog";
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
  expect(sanitizeError("request failed: Authorization: Bearer secret")).toBe(
    "request failed: Authorization: [redacted]",
  );
  expect(sanitizeError("Authorization: Basic dXNlcjpwYXNz; request failed")).toBe(
    "Authorization: [redacted]; request failed",
  );
});

it("keeps an exception's type while redacting its message and stack", () => {
  const error = new TypeError("adam@example.com is not a function");
  error.stack = "TypeError: adam@example.com is not a function\n    at run (app.js:1:1)";
  const sanitized = sanitizeException(error);

  expect(sanitized.name).toBe("TypeError");
  expect(sanitized.message).toBe("[email] is not a function");
  expect(sanitized.stack).toBe("TypeError: [email] is not a function\n    at run (app.js:1:1)");
});
