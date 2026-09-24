import posthog from "posthog-js";

const emailPattern = /[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redactEmail(value: string): string {
  return value.replace(emailPattern, "[email]");
}

export function initPostHog(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  const host = import.meta.env.VITE_POSTHOG_HOST;

  if (!import.meta.env.PROD || !key || !host) return;

  posthog.init(key, {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_exceptions: true,
    capture_performance: true,
    before_send: (event) => JSON.parse(redactEmail(JSON.stringify(event))),
    session_recording: {
      maskAllInputs: true,
      maskTextFn: redactEmail,
      maskInputFn: (text, element) =>
        element instanceof HTMLInputElement && element.id === "query"
          ? redactEmail(text)
          : "*".repeat(text.length),
    },
  });
}

export function capture(
  event: string,
  properties: Record<string, string | number | boolean>,
): void {
  if (posthog.__loaded) posthog.capture(event, properties);
}

export function identifyUser(id: string, role: "operator" | "user"): void {
  if (posthog.__loaded) posthog.identify(id, { role });
}

export function resetUser(): void {
  if (posthog.__loaded) posthog.reset();
}

export function captureError(error: Error, area: string): void {
  const sanitized = new Error(redactEmail(error.message));
  sanitized.stack = redactEmail(error.stack ?? sanitized.stack ?? "");

  if (posthog.__loaded) posthog.captureException(sanitized, { area });
}
