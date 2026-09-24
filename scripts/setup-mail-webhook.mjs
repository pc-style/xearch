import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

const env = parseEnv(await readFile(".env.local", "utf8"));

const deployment = "utmost-kudu-321";

const url = `https://${deployment}.convex.site/agentmail/webhook`;

if (!env.AGENTMAIL_API_KEY || !env.AGENTMAIL_INBOX_ID)
  throw new Error("AgentMail credentials are missing.");

async function api(path, options = {}) {
  const response = await fetch(`https://api.agentmail.to/v0${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok)
    throw new Error(
      `AgentMail ${path.split("?")[0]} returned HTTP ${response.status}. Response suppressed.`,
    );

  return response.json();
}

const inbox = await api(`/inboxes/${encodeURIComponent(env.AGENTMAIL_INBOX_ID)}`);

if (inbox.email !== env.AGENTMAIL_INBOX_ID && inbox.inbox_id !== env.AGENTMAIL_INBOX_ID)
  throw new Error("Configured inbox does not match the requested sender.");

const webhookPath = `/inboxes/${encodeURIComponent(inbox.inbox_id)}/webhooks`;

const listed = await api(`${webhookPath}?limit=100`);

if (!Array.isArray(listed.webhooks)) throw new Error("Unexpected webhook list response.");

let webhook = listed.webhooks.find((webhook) => webhook.url === url);

if (!webhook && listed.next_page_token)
  throw new Error("More webhook pages exist; inspect before creating a duplicate.");

if (!webhook)
  webhook = await api(webhookPath, {
    method: "POST",
    body: JSON.stringify({
      url,
      event_types: [
        "message.sent",
        "message.delivered",
        "message.bounced",
        "message.complained",
        "message.rejected",
      ],
      client_id: `xearch-next-${deployment}`,
    }),
  });

if (!webhook.secret)
  webhook = await api(`${webhookPath}/${encodeURIComponent(webhook.webhook_id)}`);

if (!webhook.secret) throw new Error("Webhook exists but its signing secret was not returned.");

const result = spawnSync(
  "bunx",
  ["convex", "env", "set", "AGENTMAIL_WEBHOOK_SECRET", "--deployment", deployment],
  { input: webhook.secret + "\n", encoding: "utf8" },
);

if (result.status !== 0)
  throw new Error("Webhook exists but secret sync failed. No secrets were printed.");

console.log(
  `Registered delivery-only callback for the configured inbox at ${url}. Signing secret configured in production.`,
);
