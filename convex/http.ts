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

// The component's 0.1 types require mutation-context transaction options;
// the webhook uses only runMutation(function, args), supported by HTTP actions.
http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction((ctx, request) =>
    new AgentMail(components.agentmail).handleWebhook(
      ctx as unknown as Parameters<AgentMail["handleWebhook"]>[0],
      request,
    ),
  ),
});

registerStaticRoutes(http, components.staticHosting);

export default http;
