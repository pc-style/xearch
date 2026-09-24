/** 52206 → "52k", 9499 → "9.5k", 1_200_000 → "1.2M" — the wall's compact counts. */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;

  if (n >= 10_000) return `${Math.round(n / 1000)}k`;

  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;

  return String(n);
}

const sameYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const otherYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Sep 22" this year, "Sep 22, 2024" otherwise; null for a missing or bad date. */
export function postDate(ms: number | undefined, now = Date.now()): string | null {
  if (ms === undefined) return null;
  const date = new Date(ms);

  if (Number.isNaN(date.getTime())) return null;

  return (date.getFullYear() === new Date(now).getFullYear() ? sameYear : otherYear).format(date);
}

export const safeHostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "Linked page";
  }
};
