import type { ProviderLimit } from "../../convex/limits";
import { Badge } from "./format.tsx";

const PROVIDER_DISPLAY_NAME: Record<ProviderLimit["provider"], string> = {
  xmd: "x.md",
  receiver: "Raw-capture receiver",
  search: "Search backend",
};

/**
 * Provider-reported throttling (to-do.md P0 "Provider limits"). Built only
 * from `convex/limits.ts` (`ProviderLimit[]`) — never `jobs.error`, which can
 * hold a stale historical message left on an old job row, indistinguishable
 * from a live one by content alone.
 *
 * B2 ("hide provider limits unless something is actually throttled"):
 * unlike the badge-per-provider panel this used to be, this renders nothing
 * at all — not a heading, not a "No throttling reported" badge, not a
 * "loading…"/"connect to view" placeholder — until at least one provider has
 * actually reported being throttled. A permanent row of green badges is not
 * a fact worth a person's attention; a real throttle is.
 */
export default function ProviderLimits({
  limits,
}: {
  limits: ProviderLimit[] | undefined;
  isAuthenticated: boolean;
}) {
  const throttled = limits?.filter(
    (l): l is Extract<ProviderLimit, { kind: "throttled" }> => l.kind === "throttled",
  );

  if (!throttled || throttled.length === 0) return null;

  return (
    <div>
      <h3 className="library-subhead">Provider limits</h3>
      <div className="library-health-row" role="status">
        {throttled.map((limit) => (
          <Badge key={limit.provider} tone="warning">
            {PROVIDER_DISPLAY_NAME[limit.provider]}: Throttled on {limit.operation}
          </Badge>
        ))}
      </div>
      <div>
        {throttled.map((limit) => (
          <p className="library-muted" key={limit.provider}>
            {PROVIDER_DISPLAY_NAME[limit.provider]}: {limit.reason}
            {limit.remaining.kind === "known"
              ? ` — ${limit.remaining.value.toLocaleString()} remaining`
              : " — remaining allowance unknown"}
            {limit.resetAt !== undefined
              ? `, resets ${new Date(limit.resetAt).toLocaleTimeString()}`
              : ""}
            {limit.nextRetryAt !== undefined
              ? `. Next retry around ${new Date(limit.nextRetryAt).toLocaleTimeString()}.`
              : ""}
          </p>
        ))}
      </div>
    </div>
  );
}
