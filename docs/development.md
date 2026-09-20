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
New history imports request up to 5,000 posts per JSON page (x.md's documented
maximum; the old 500 clamp was this app's). Continuation stays in one job and
stops if the date boundary fails to move backwards. A page that exceeds the 4 MB
capture budget is split into envelope-shaped parts — see
[the integration contract](integration-contract.md). Only provider-reported
limits should pause acquisition; the application has no daily import budget.
Counts show received posts and may include repeated posts at inclusive page
boundaries. Stop prevents later work and acknowledgments; an already-running
upstream request may still finish and already-written files remain. Technical
details show up to 100 receipts per job. Older completed jobs with more history
offer a continuation button; they are not silently restarted.

Put backend keys and `OPENAI_MODEL` in `.env.local`, then run `bun run env:sync`. The script only syncs allowlisted nonempty variables to the local anonymous deployment and never prints their values. AgentMail webhooks need a public deployment URL; leave the webhook secret unset during local work unless a public callback has separately been configured.

Import controls work without `SEARCH_API_URL`. The separately owned search
service's application boundary is documented in the
[integration contract](integration-contract.md).

## Connect providers

Use `bunx convex env set NAME` and supply the value through stdin/the prompt. Do not use `VITE_` variables for secrets.

| Variable                    | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `X_MD_API_KEY`              | x.md acquisition credential                                 |
| `X_MD_BASE_URL`             | Optional alternate official origin, `https://x.pcstyle.dev` |
| `RAW_CAPTURE_URL`           | Durable raw-capture receiver                                |
| `SEARCH_API_URL`            | Search service retrieval endpoint                           |
| `SEARCH_SERVICE_TOKEN`      | Read-only credential for the search endpoint                |
| `PUBLICATION_SERVICE_TOKEN` | Auth for `POST /publication/update` (indexer → Convex)      |
| `RAW_CAPTURE_TOKEN`         | Ingestion-only credential for the capture receiver          |
| `DATA_SERVICE_TOKEN`        | Legacy shared fallback when a dedicated token is unset      |
| `COLLECTOR_MODE`            | `outbound` makes Convex skip x.md/capture (production only) |
| `COLLECTOR_TOKEN`           | Production worker auth; never set on a local deployment     |
| `FIRECRAWL_API_KEY`         | Linked-page scraping and web-context search                 |
| `OPENAI_API_KEY`            | Editable query interpretation                               |
| `OPENAI_MODEL`              | Optional model override; default `gpt-5-mini`               |
| `AGENTMAIL_API_KEY`         | Result-digest delivery                                      |
| `AGENTMAIL_INBOX_ID`        | Existing sender inbox                                       |
| `AGENTMAIL_WEBHOOK_SECRET`  | Verification of delivery webhooks                           |

Register AgentMail's webhook at `<deployment>.convex.site/agentmail/webhook` for delivery events. A send is queued only by the explicit Email → Send results action. The interface distinguishes queued/sent/delivered states.

`PUBLICATION_SERVICE_TOKEN`, `COLLECTOR_MODE`, and `COLLECTOR_TOKEN` are set
with `bunx convex env set` (or `scripts/setup-worker.mjs` for the last two on
production), not `bun run env:sync` — that script's allowlist does not include
them. Keep anonymous local deployments in receiver mode: if `COLLECTOR_MODE`
is `outbound` here, `convex/importer.ts` no-ops and nothing polls for jobs.
The indexer's `PUBLICATION_UPDATE_URL` is not a Convex variable; it belongs in
the indexer env file, and it must be `https://` — the sender refuses a
non-loopback `http://` endpoint outright rather than sending a bearer token in
cleartext. Plain `http://` to `127.0.0.1`, `::1` or `localhost` is still
accepted, which is what a local test responder uses. See
[indexer operations](search-indexer.md).

The UI exposes account imports, search, and conversation collection. The same
`jobs.start` API accepts `profile`, `following`, `followers`, and `archive`;
these preserve complete responses for downstream account-discovery work. Only
`kind: "bulk"` collect returns a profile, and only `jobs.finish` with that
profile creates an `accounts` row (`upsertAccount`). A `profile` job is a
capture of the profile endpoint, not a library row. `bulk` supports
`refresh:true` for engagement updates. All collection paths require a
configured receiver (local) or a live download worker (production outbound
mode), so an import never claims success by merely fetching data. Production
currently never delivers `profile` through `worker.report` — see
[the control plane](control-plane.md) and
[production operations](production.md) "Outbound collector and accounts".

Dashboard workflows, identity rules, provider-limit honesty, and worker liveness are in [the control plane](control-plane.md). Finished runs can be cleared from the list and restored; clearing hides a row and deletes nothing. Live input `from:handle`, `@Handle`, and `@handle rest` store as one canonical search.

## Verify

```sh
bun run lint
bun run typecheck
bun run test
bunx vite build --outDir "$(mktemp -d /tmp/xearch-build.XXXXXX)"
```

Build verification uses a temporary directory so it cannot overwrite the live VM frontend in `dist/`.

Oxlint runs with the Effect presets; `prepare` patches Oxlint and tsgolint on
install. `bun run lint` is Oxlint alone. React Doctor is a separate, advisory
GitHub Actions check scoped to `src/` (`.github/workflows/react-doctor.yml`,
`blocking: none`) and runs locally as `bun run react-doctor`; its findings do
not gate `Check`. Search-service responses are decoded with Effect Schema
in `convex/lib/results.ts`; other validators still use Zod.

Tests cover raw payload preservation, JSON backfill pagination, split oversized history pages, safe unordered-stream behavior, stream completion, partial capture, identity pinning and handle reassignment, origin selection, retry timing, durable receipts, user isolation, owner-scoped stats, provider-throttle writes, job dismissal, worker liveness, and the Firecrawl component response shape. Provider calls are mocked in tests. No email is sent and no provider credits are consumed by the suite. Selected ideas and remaining work from the supplied local-first spec are tracked in [spec adoption](spec-adoption.md).

## Guest sessions and publication

Guest sessions let users use the app without an invite. Saved state belongs to
that browser session; clearing its credentials loses access. Guest sessions are
not verified email identities. Durable email sign-in exists (`convex/auth.ts`'s
Email OTP provider, delivered through AgentMail) and gates sending a digest to a
verified, matching address (`convex/email.ts` `send`); an anonymous guest session
can search and import but can never pass that gate. The publication receiver,
dashboard queries, and in-repo indexer sender exist (`convex/publication.ts`,
`convex/summary.ts`, `convex/library.ts`, `convex/limits.ts`,
`search/crates/indexer/src/publish.rs` — see
[the publication contract](publication-contract.md) and
[the control plane](control-plane.md)). The sender has been probed against
production over TLS with no account state written; no real account has been
published yet, and AgentMail send has not been live-tested. Raw acquisition
receipts do not confirm downstream indexing. Search pages are short-lived UI
snapshots, not a local corpus. Pronsh owns the corpus and search implementation.
