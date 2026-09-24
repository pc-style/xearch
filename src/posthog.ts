import type { PostHog } from "posthog-js";

const emailPattern = /[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redactEmail(value: string): string {
  return value.replace(emailPattern, "[email]");
}

// posthog-js is loaded on demand, only in a production build that has a key:
// it outweighs the rest of the app, and most builds (dev, tests, a deploy
// without analytics) never use it. Calls made before it arrives are queued
// and replayed once it has initialised, so nothing early in a visit is lost.
let client: PostHog | null = null;

let pending: Array<(posthog: PostHog) => void> | null = null;

function withClient(call: (posthog: PostHog) => void): void {
  if (client) call(client);
  else pending?.push(call);
}

export function initPostHog(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  const host = import.meta.env.VITE_POSTHOG_HOST;

  if (!import.meta.env.PROD || !key || !host) return;

  pending = [];

  void import("posthog-js").then(
    ({ default: posthog }) => {
      posthog.init(key, {
        api_host: host,
        autocapture: false,
        capture_pageview: true,
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
      client = posthog;

      for (const call of pending ?? []) call(posthog);
      pending = null;
    },
    () => {
      // Blocked or offline: analytics is optional, so drop the queue.
      pending = null;
    },
  );
}

export function capture(
  event: string,
  properties: Record<string, string | number | boolean>,
): void {
  withClient((posthog) => posthog.capture(event, properties));
}

export function identifyUser(id: string, role: "operator" | "user"): void {
  withClient((posthog) => posthog.identify(id, { role }));
}

export function resetUser(): void {
  withClient((posthog) => posthog.reset());
}

export function captureError(error: Error, area: string): void {
  const sanitized = new Error(redactEmail(error.message));
  sanitized.stack = redactEmail(error.stack ?? sanitized.stack ?? "");

  withClient((posthog) => posthog.captureException(sanitized, { area }));
}
