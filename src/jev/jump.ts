const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

const SPRING = "cubic-bezier(0.34, 1.3, 0.64, 1)";

/**
 * Make every card in `target` jump in an arc from where the same post sits
 * in `source`; cards with no counterpart pop in place. Call right after the
 * target list rendered (after `flush()`), so its final layout is measurable.
 */
export function jumpFrom(source: HTMLElement, target: HTMLElement): void {
  // Optional calls: jsdom (the tests) has neither API.
  if (!target.animate) return;

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const origins = new Map<string, DOMRect>();

  for (const card of source.querySelectorAll<HTMLElement>("[data-tweet]"))
    origins.set(card.dataset.tweet ?? "", card.getBoundingClientRect());

  target.querySelectorAll<HTMLElement>("[data-tweet]").forEach((card, slot) => {
    const delay = Math.min(slot, 20) * 45;
    const from = origins.get(card.dataset.tweet ?? "");

    if (!from) {
      card.animate(
        [
          { opacity: 0, transform: "scale(0.9)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 320, delay, easing: EASE_OUT, fill: "backwards" },
      );

      return;
    }

    const to = card.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const lift = Math.min(120, 40 + Math.abs(dx) * 0.15);
    const tilt = dx > 0 ? -3 : 3;

    card.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.5 },
        {
          transform: `translate(${dx / 2}px, ${dy / 2 - lift}px) scale(1.06) rotate(${tilt}deg)`,
          opacity: 1,
          offset: 0.45,
        },
        { transform: "none", opacity: 1 },
      ],
      { duration: 650, delay, easing: SPRING, fill: "backwards" },
    );
  });
}
