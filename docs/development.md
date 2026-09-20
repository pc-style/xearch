# Development

These instructions are for an explicitly isolated local checkout, not the
production VM. For existing services and deployment, see
[production operations](production.md). Never run setup scripts against a
shared deployment as part of routine verification.

## Run locally

```sh
bun install --frozen-lockfile
CONVEX_AGENT_MODE=anonymous bun run backend
```

Leave the backend running. In another terminal, confirm `.env.local` selects
the new anonymous deployment before configuring it. On the first run the
Firecrawl component requires its environment variable to exist. Without a key
yet, set an empty value so other features can run; Firecrawl operations remain
disabled:

```sh
bunx convex env set FIRECRAWL_API_KEY ''
node scripts/setup-auth.mjs --local
bun run dev
```

Run the auth-key script once per new local deployment. It generates backend
signing keys without printing their values. Re-running rotates them and signs
out existing sessions. The frontend is http://localhost:5173. `.env.local` and
`.convex/` are ignored. Use Connections in the app to inspect which integrations
are configured.

## Local import dashboard

Open `http://localhost:5173/?dashboard=1` for the live import controls. Start/stop/retry jobs, continue older pages, and inspect raw-capture receipts. All seven x.md collection tasks are available. Jobs are private to the current guest session; other tabs in that session update through Convex subscriptions.

With the local backend running, configure the temporary local receiver once,
then leave it running alongside the backend and frontend:

```sh
bun run capture:setup
bun run capture
```

The setup script is restricted to this anonymous local Convex deployment. It generates a private token and configures the loopback receiver automatically. Captures are saved unchanged under `.local-captures/raw/<sha256>.json`; the token is `.local-captures/token`. Both are ignored by Git. The receiver is loopback-only, checks authorization and checksums, and syncs files before acknowledging them. It is a temporary raw-file sink, not the normalization or search backend, and has no automatic deletion or disk quota. Monitor disk use. It is not suitable for a hosted Convex deployment without replacing the receiver with an authenticated reachable service.

`Downloaded` means raw handoff completed, not confirmed search publication.
New history imports automatically fetch older 500-post batches under one job
and stop if the date boundary fails to move backwards. Only provider-reported
limits should pause acquisition; the application has no daily import budget.
Counts show received posts and may include repeated posts at inclusive page
boundaries. Stop prevents later work and acknowledgments; an already-running
upstream request may still finish and already-written files remain. Technical
details show up to 100 receipts per job. Older completed jobs with more history
offer a continuation button; they are not silently restarted.

Overview tiles are owner-scoped (your imports only) and labelled by unit.
Waiting/active downloads and failed & retryable are job counts from this
app. "Saved captures awaiting indexing" is a capture/file count, never
posts. "Queued posts", "Queued captures", and "Queued indexer jobs" are
the indexer's `pendingWork` from publication updates, shown as three
tiles that are never added together. A tile that says "not yet known" means
no in-scope account has reported that unit — the current Rust sender does
not emit `pendingWork`, so those three stay unknown until it does. A known
0 means someone actually reported zero. See
[the publication contract](publication-contract.md).

Dependency health is a different fact from Connections "configured". Health
is an observed timestamped reading (`convex/summary.ts` `health`): indexer
watch-pass heartbeats, a 2-minute Convex probe of the search `/health`
body `ok`, and the production worker forwarding loopback receiver
`/health`. A service that has never reported reads "No health report
received yet"; a reading older than five minutes is labelled stale, never
shown as a live zero. Local pitfalls:

- `bun run capture` answers `http://127.0.0.1:4319/health` but does **not**
  write a Convex `serviceHealth` row. Only `scripts/production-worker.ts`
  forwards receiver liveness.
- Search stays unknown unless `SEARCH_API_URL` is set on the Convex
  deployment (the cron has nowhere to probe).
- Indexer heartbeats need `SERVICE_HEALTH_URL` and `SERVICE_HEALTH_TOKEN`
  in the watcher's environment, plus `SERVICE_HEALTH_TOKEN` on Convex.
  One-shot `xearch-search import` does not heartbeat.

`bun run env:sync` does not include `SERVICE_HEALTH_TOKEN` or
`PUBLICATION_SERVICE_TOKEN`. Set those with `bunx convex env set NAME` on
the local anonymous deployment if you are exercising those routes. Do not
print the values.

Put backend keys and `OPENAI_MODEL` in `.env.local`, then run `bun run env:sync`. The script only syncs allowlisted nonempty variables to the local anonymous deployment and never prints their values. AgentMail webhooks need a public deployment URL; leave the webhook secret unset during local work unless a public callback has separately been configured.

Import controls work without `SEARCH_API_URL`. The separately owned search
service's application boundary is documented in the
[integration contract](integration-contract.md).

## Connect providers

Use `bunx convex env set NAME` and supply the value through stdin/the prompt. Do not use `VITE_` variables for secrets.

| Variable                    | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `X_MD_API_KEY`              | x.md acquisition credential                                      |
| `X_MD_BASE_URL`             | Optional alternate official origin, `https://x.pcstyle.dev`      |
| `RAW_CAPTURE_URL`           | Durable raw-capture receiver                                     |
| `SEARCH_API_URL`            | Search service retrieval endpoint                                |
| `SEARCH_SERVICE_TOKEN`      | Read-only credential for the search endpoint                     |
| `RAW_CAPTURE_TOKEN`         | Ingestion-only credential for the capture receiver               |
| `DATA_SERVICE_TOKEN`        | Legacy shared fallback when a dedicated token is unset           |
| `PUBLICATION_SERVICE_TOKEN` | Indexer push to `POST /publication/update`; not in `env:sync`    |
| `SERVICE_HEALTH_TOKEN`      | Indexer/worker push to `POST /service/health`; not in `env:sync` |
| `FIRECRAWL_API_KEY`         | Linked-page scraping and web-context search                      |
| `OPENAI_API_KEY`            | Editable query interpretation                                    |
| `OPENAI_MODEL`              | Optional model override; default `gpt-5-mini`                    |
| `AGENTMAIL_API_KEY`         | Result-digest delivery                                           |
| `AGENTMAIL_INBOX_ID`        | Existing sender inbox                                            |
| `AGENTMAIL_WEBHOOK_SECRET`  | Verification of delivery webhooks                                |

Register AgentMail's webhook at `<deployment>.convex.site/agentmail/webhook` for delivery events. A send is queued only by the explicit Email → Send results action. The interface distinguishes queued/sent/delivered states.

The UI exposes account imports, search, and conversation collection. The same `jobs.start` API accepts `profile`, `following`, `followers`, and `archive`; these preserve complete responses for downstream account-discovery work. `bulk` supports `refresh:true` for engagement updates. All collection paths require a configured receiver, so an import never claims success by merely fetching data.

## Verify

```sh
bun run lint
bun run typecheck
bun run test
bunx vite build --outDir "$(mktemp -d /tmp/xearch-build.XXXXXX)"
```

Build verification uses a temporary directory so it cannot overwrite the live VM frontend in `dist/`.

Oxlint runs with the Effect presets; `prepare` patches Oxlint and tsgolint on
install. Search-service responses are decoded with Effect Schema
in `convex/lib/results.ts`; other validators still use Zod.

Tests cover raw payload preservation, JSON backfill pagination, safe unordered-stream behavior, stream completion, partial capture, identity pinning, origin selection, retry timing, durable receipts, user isolation, and the Firecrawl component response shape. Provider calls are mocked in tests. No email is sent and no provider credits are consumed by the suite. Selected ideas and remaining work from the supplied local-first spec are tracked in [spec adoption](spec-adoption.md).

## Guest sessions and publication

Guest sessions let users use the app without an invite. Saved state belongs to
that browser session; clearing its credentials loses access. Guest sessions are
not verified email identities. Durable email sign-in exists (`convex/auth.ts`'s
Email OTP provider, delivered through AgentMail) and gates sending a digest to a
verified, matching address (`convex/email.ts` `send`); an anonymous guest session
can search and import but can never pass that gate. The publication receiver, dashboard queries, and health writers also exist
(`convex/publication.ts`, `convex/summary.ts`, `convex/library.ts`,
`convex/limits.ts`, `convex/health.ts` — see
[the publication contract](publication-contract.md)). None of this has been
exercised against a real AgentMail send or a real published account yet —
only against mocks, a local convex-test deployment, and TLS 422/401 probes
that mutated no state — which [the application
backlog](../to-do.md) still tracks as open verification work. Raw acquisition
receipts do not confirm downstream indexing. Search pages are short-lived UI
snapshots, not a local corpus. Pronsh owns the corpus and search implementation.
