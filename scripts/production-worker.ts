import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { collectXmd } from "../convex/lib/collect";
import { XmdClient, ProviderError, string } from "../convex/lib/xmd";
import { deliverCapture } from "../convex/lib/handoff";
const env = parseEnv(await readFile(".env.local", "utf8"));
if (!env.X_MD_API_KEY) throw new Error("Local X_MD_API_KEY is required.");
const token = (await readFile(".local-captures/worker-token", "utf8")).trim();
const captureToken = (await readFile(".local-captures/token", "utf8")).trim();
const client = new ConvexHttpClient("https://utmost-kudu-321.convex.cloud");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
// One real observation of the loopback capture receiver, with the failure
// text kept verbatim: it is both this worker's own "can I still save
// anything" check AND, forwarded through worker:poll, the only thing that
// ever observes the receiver for the dashboard's service-health panel
// (convex/health.ts). `healthy: true` here always means a response was
// actually received — never that a setting is present.
async function receiverHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const response = await fetch("http://127.0.0.1:4319/health", {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok
      ? { healthy: true }
      : { healthy: false, error: `Capture receiver answered HTTP ${response.status}.` };
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : "Capture receiver did not respond.",
    };
  }
}
console.log(
  "Production download worker started. Connections are outbound only; raw posts stay on this machine.",
);
// `stopping` is flipped by the SIGINT/SIGTERM handlers above; the break keeps
// the shutdown check explicit without a loop condition the linter must track.
for (;;) {
  if (stopping) break;
  try {
    const receiver = await receiverHealth();
    const job = await client.action("worker:poll" as any, {
      token,
      online: receiver.healthy,
      receiver,
    });
    if (job) {
      console.log(`Downloading ${job.kind} for ${job.input}`);
      const report = (args: Record<string, unknown>) =>
        client.action("worker:report" as any, {
          token,
          jobId: job._id,
          attempt: job.attempt,
          ...args,
        });
      const heartbeat = setInterval(() => {
        void receiverHealth()
          .then((receiver) =>
            client.action("worker:poll" as any, {
              token,
              heartbeatOnly: true,
              online: receiver.healthy,
              receiver,
            }),
          )
          .catch(() => {});
      }, 15000);
      try {
        const result = await collectXmd(
          new XmdClient(env.X_MD_API_KEY, fetch, env.X_MD_BASE_URL),
          {
            runId: job._id,
            attempt: job.attempt,
            kind: job.kind,
            input: job.input,
            since: job.since,
            until: job.until,
            cursor: job.cursor,
            refresh: job.refresh,
            expectedUserId: job.expectedUserId,
          },
          (capture) => deliverCapture("http://127.0.0.1:4319/captures", captureToken, capture),
          async (receipt, count) => {
            await report({
              event: "receipt",
              captureId: receipt.captureId,
              receiptId: receipt.receiptId,
              count,
            });
          },
          Date.now,
          async (userId) => {
            await report({ event: "identity", userId });
          },
          async (phase) => {
            if (stopping) throw new Error("Worker stopping");
            await report({ event: "phase", phase });
          },
        );
        // The profile is what creates the account row, so it must travel —
        // it used to be destructured off and dropped here, which left the
        // production `accounts` table permanently empty even though every
        // job had its identity pinned. Same shape and same validation
        // convex/importer.ts applies on the in-Convex path: a handle that
        // is actually a handle, an id we really pinned, and an avatar only
        // when it is an https URL.
        const { profile: rawProfile, ...summary } = result;
        const screenName = rawProfile && string(rawProfile.screen_name);
        await report({
          event: "finish",
          ...summary,
          profile:
            screenName && /^[A-Za-z0-9_]{1,15}$/.test(screenName) && result.expectedUserId
              ? {
                  handle: screenName.toLowerCase(),
                  userId: result.expectedUserId,
                  name: string(rawProfile!.name) ?? screenName,
                  avatar: string(rawProfile!.avatar_url)?.startsWith("https://")
                    ? string(rawProfile!.avatar_url)
                    : undefined,
                }
              : undefined,
        });
        console.log("Batch saved; production progress updated.");
      } catch (error) {
        // This worker is the only thing that talks to x.md in production, so
        // it is the only place a provider's "slow down" is ever observed.
        // Reported separately from the finish below: the job's outcome and
        // what the provider said are two different facts, and the throttle
        // observation must survive even if the finish is rejected as a stale
        // attempt.
        if (error instanceof ProviderError && error.throttle) {
          const throttle = error.throttle;
          await report({
            event: "throttle",
            throttle: {
              provider: throttle.provider,
              operation: throttle.operation,
              reason: throttle.reason ?? error.message,
              remaining: throttle.remaining,
              resetAt: throttle.resetAt,
              retryAfterMs: throttle.retryAfterMs,
              observedAt: throttle.observedAt,
            },
          }).catch(() => {});
        }
        await report({
          event: "finish",
          error:
            error instanceof ProviderError
              ? error.message
              : "Download interrupted. Saved batches are safe. Retry to continue.",
          retryAfter:
            error instanceof ProviderError && error.retryable ? error.retryAfter : undefined,
        });
        console.log("Job interrupted; see its production status for details.");
      } finally {
        clearInterval(heartbeat);
      }
    }
  } catch {
    console.log("Worker connection unavailable. Retrying shortly; credentials are not logged.");
  }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5000));
}
// Shutdown: `online: false` is a statement about this worker, not about the
// receiver, so no `receiver` field goes with it. Claiming the receiver is
// down because we are stopping would be an observation we never made.
await client
  .action("worker:poll" as any, { token, heartbeatOnly: true, online: false })
  .catch(() => {});
