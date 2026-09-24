import { defineApp } from "convex/server";
import { v } from "convex/values";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import agentmail from "@agentmail/convex/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import posthog from "@posthog/convex/convex.config";

const app = defineApp({
  env: {
    FIRECRAWL_API_KEY: v.string(),
    POSTHOG_PROJECT_TOKEN: v.string(),
    POSTHOG_HOST: v.string(),
    // The operator build's own token and its rotation counterpart
    // (convex/access.ts `requireOperator`, docs/production.md "To rotate
    // it"). Typed here per convex/_generated/ai/guidelines.md's env-var
    // guidance, rather than read off `process.env` directly.
    OPERATOR_TOKEN: v.optional(v.string()),
    OPERATOR_TOKEN_PREVIOUS: v.optional(v.string()),
  },
});

app.use(firecrawl, { env: { FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY } });

app.use(agentmail);

app.use(staticHosting);

app.use(posthog, {
  env: {
    POSTHOG_PROJECT_TOKEN: app.env.POSTHOG_PROJECT_TOKEN,
    POSTHOG_HOST: app.env.POSTHOG_HOST,
  },
});

export default app;
