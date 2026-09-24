import { PostHog } from "@posthog/convex";
import { components } from "../_generated/api";
import { env } from "../_generated/server";

const posthog = new PostHog(components.posthog);

export async function capturePostHog(
  ctx: Parameters<PostHog["capture"]>[0],
  event: Parameters<PostHog["capture"]>[1],
): Promise<void> {
  if (env.POSTHOG_PROJECT_TOKEN === "disabled") return;

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
