import { PostHog } from "@posthog/convex";
import { components } from "../_generated/api";
import { env } from "../_generated/server";

const posthog = new PostHog(components.posthog);

/**
 * The literal token "disabled" turns capture off for a deployment. The
 * component (@posthog/convex convex.config) declares the token as a required
 * string, so a deployment cannot simply leave it unset; this is the one
 * documented way to run without PostHog (docs/production.md).
 */
export function posthogDisabled(): boolean {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim() ?? "";

  return token === "" || token === "disabled";
}

export async function capturePostHog(
  ctx: Parameters<PostHog["capture"]>[0],
  event: Parameters<PostHog["capture"]>[1],
): Promise<void> {
  if (posthogDisabled()) return;

  try {
    await posthog.capture(ctx, event);
  } catch {
    console.warn("PostHog event scheduling failed");
  }
}

export function redactEmail(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
}

export function sanitizeError(value: string): string {
  return redactEmail(value)
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/\bauthorization\s*[:=]\s*[^\r\n;,]+/gi, "Authorization: [redacted]")
    .replace(/\b(bearer|token|api[_-]?key)\s*[:=]?\s*[^\s,;]+/gi, "$1 [redacted]")
    .slice(0, 300);
}
