import { flush } from "solid-js";

/**
 * Apply a view change inside the View Transition API where the browser has
 * it (the home ↔ results crossfade and the search form gliding between the
 * two layouts, see style.css), and plainly where it doesn't or the person
 * prefers reduced motion. `flush()` makes Solid write the DOM inside the
 * transition's callback, so the "after" snapshot is the new view.
 */
export function withViewTransition(update: () => void): void {
  // Optional calls: jsdom (the tests) has neither API.
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  if (!document.startViewTransition || reduced) {
    update();

    return;
  }

  document
    .startViewTransition(() => {
      update();
      flush();
    })
    .ready.catch(() => {});
}
