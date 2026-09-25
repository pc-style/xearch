/**
 * Lucide icons (lucide.dev, ISC licence), inlined as the handful of path
 * strings this app draws — a whole icon package for ~25 glyphs is most of a
 * bundle. A few carry classes (`hand`, `mark`, `needle`) that style.css
 * animates; those shapes come from the design, not stock Lucide.
 */
const PATHS = {
  "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  bookmark:
    '<path class="mark" d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path class="hand" d="M12 6v6l4 2"/>',
  compass:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2v2.5M22 12h-2.5M12 22v-2.5M2 12h2.5" stroke-width="1.5"/><g class="needle"><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none"/></g>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  download:
    '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  ellipsis:
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  "external-link":
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  heart:
    '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>',
  "layout-dashboard":
    '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  mail: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
  "message-circle":
    '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "repeat-2":
    '<path d="m2 9 3-3 3 3"/><path d="M13 18H7a2 2 0 0 1-2-2V6"/><path d="m22 15-3 3-3-3"/><path d="M11 6h6a2 2 0 0 1 2 2v10"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  sliders:
    '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

export type IconName = keyof typeof PATHS;

// Each glyph's markup is parsed once, then cloned: a result list draws a
// handful of icons per row, and setting `innerHTML` on every one of them
// re-ran the HTML parser each time.
const parsed = new Map<IconName, SVGSVGElement>();

function glyph(name: IconName): Node[] {
  let template = parsed.get(name);

  if (!template) {
    template = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    template.innerHTML = PATHS[name];
    parsed.set(name, template);
  }

  return Array.from(template.childNodes, (node) => node.cloneNode(true));
}

export function Icon(props: { name: IconName; size?: number; class?: string }) {
  return (
    <svg
      class={["ic", props.class]}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {glyph(props.name)}
    </svg>
  );
}
