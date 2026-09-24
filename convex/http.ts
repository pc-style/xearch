import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components } from "./_generated/api";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { AgentMail } from "@agentmail/convex";
import { auth } from "./auth";
import { receiveUpdate } from "./publication";
import { receiveReport } from "./health";

const http = httpRouter();

auth.addHttpRoutes(http);

// Pronsh's indexer pushes authenticated, idempotent publication updates
// here. See convex/publication.ts and docs/publication-contract.md.
http.route({
  path: "/publication/update",
  method: "POST",
  handler: receiveUpdate,
});

// Out-of-process services report their own liveness here, authenticated
// with their own capability token. See convex/health.ts; the read side is
// convex/summary.ts's `health` query.
http.route({
  path: "/service/health",
  method: "POST",
  handler: receiveReport,
});

// The component's 0.1 types declare `runMutation(fn, args)` without the
// transaction-options third parameter that an HTTP action's own `ctx.runMutation`
// overload adds, so the two packages' ambient Convex types don't line up closely
// enough to hand `ctx` straight to `handleWebhook`. Routing the one call the
// webhook actually makes through a same-shaped wrapper keeps the real call
// (`ctx.runMutation(mutation, args)`, no third argument) type-checked against
// both packages' types instead of casting the whole context across the gap.
http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction((ctx, request) => {
    // SAFETY: `ctx.runMutation` is Convex's own generic `runMutation`, just
    // instantiated against this HTTP action's overload (which additionally
    // accepts a `transactionLimits` option this component's vendored,
    // narrower type never declares or passes). The two are the same function
    // with the same runtime contract for every call this wrapper makes
    // (mutation reference plus its args, no transactionLimits) - only their
    // independently-authored ambient generic signatures disagree.
    const mutationCtx: Parameters<AgentMail["handleWebhook"]>[0] = {
      runMutation: ctx.runMutation as Parameters<AgentMail["handleWebhook"]>[0]["runMutation"],
    };

    return new AgentMail(components.agentmail).handleWebhook(mutationCtx, request);
  }),
});

registerStaticRoutes(http, components.staticHosting);

export default http;
