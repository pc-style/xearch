import { flush } from "solid-js";
import { captureError } from "./posthog";

/**
 * Apply a view change inside the View Transition API where the browser has
 * it (the home ↔ results crossfade and the search form gliding between the
 * two layouts, see style.css), and plainly where it doesn't or the person
 * prefers reduced motion. `flush()` makes Solid write the DOM inside the
 * transition's callback, so the "after" snapshot is the new view.
 */
export function withViewTransition(
  update: () => void,
  report: (error: Error, area: string) => void = captureError,
): void {
  // Optional calls: jsdom (the tests) has neither API.
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  if (!document.startViewTransition || reduced) {
    update();

    return;
  }

  const transition = document.startViewTransition(() => {
    update();
    flush();
  });

  // A throw from `update` rejects all three promises. That is an app error,
  // so report it once through `updateCallbackDone`; `ready` also rejects
  // when only the animation is skipped, which is not worth reporting.
  transition.updateCallbackDone.catch((error) =>
    report(error instanceof Error ? error : new Error(String(error)), "view-transition"),
  );
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
}
