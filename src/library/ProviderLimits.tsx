import type { ProviderLimit } from "../../convex/limits";
import { Badge } from "./format";

const PROVIDER_DISPLAY_NAME: Record<ProviderLimit["provider"], string> = {
  xmd: "x.md",
  receiver: "Raw-capture receiver",
  search: "Search backend",
};
const PROVIDERS = ["xmd", "receiver", "search"] as const;

/**
 * Provider-reported throttling (to-do.md P0 "Provider limits"). Built only
 * from `convex/limits.ts` (`ProviderLimit[]`) — never `jobs.error`, which can
 * hold a stale historical message left on an old job row, indistinguishable
 * from a live one by content alone. See convex/limits.ts's own header
 * comment for exactly which of the four "Provider limits" to-do.md bullets
 * this closes: showing the fact once one exists. Nothing writes a live
 * throttle observation yet, so every provider honestly renders "No
 * throttling reported" today — not a guessed "ok", and not silence. This
 * panel needs no change once a write path lands; it will start showing real
 * facts the moment `providerThrottleEvents` rows exist.
 */
export default function ProviderLimits({ limits }: { limits: ProviderLimit[] | undefined }) {
  const throttled = limits?.filter(
    (l): l is Extract<ProviderLimit, { kind: "throttled" }> => l.kind === "throttled",
  );
  return (
    <div>
      <h3 className="library-subhead">Provider limits</h3>
      <div className="library-health-row" role="status">
        {!limits
          ? PROVIDERS.map((provider) => (
              <Badge key={provider} tone="neutral">
                {PROVIDER_DISPLAY_NAME[provider]}: loading…
              </Badge>
            ))
          : limits.map((limit) => (
              <Badge key={limit.provider} tone={limit.kind === "throttled" ? "warning" : "neutral"}>
                {PROVIDER_DISPLAY_NAME[limit.provider]}:{" "}
                {limit.kind === "none" ? "No throttling reported" : `Throttled on ${limit.operation}`}
              </Badge>
            ))}
      </div>
      {throttled && throttled.length > 0 && (
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
      )}
      <p className="library-muted">
        Provider-reported throttling only, never an old error left on a job. "No throttling
        reported" means none has been observed, not that one was checked and ruled out. Unknown
        remaining allowance is shown as unknown, never zero or an estimate.
      </p>
    </div>
  );
}
