# Production deployment

Two sites are built from this one source tree, and they are not the same
application.

|                        | operator site                          | public site                         |
| ---------------------- | -------------------------------------- | ----------------------------------- |
| url                    | https://exp-xearch.exe.xyz:8080/       | https://utmost-kudu-321.convex.site |
| served by              | nginx on this VM                       | Convex static hosting               |
| who can reach it       | exe.dev accounts with access to the VM | anyone                              |
| contains the dashboard | yes                                    | no                                  |
| build                  | `bash scripts/deploy-operator-site.sh` | `bun run deploy:prod`               |

The dashboard, the Connections panel and the account library exist only in the
operator build (`VITE_XEARCH_OPERATOR=1`). The public build resolves
`src/operatorSurface.ts` to a stub that imports nothing, so those modules are
absent from its bundle rather than merely unreachable inside it;
`scripts/check-public-bundle.mjs` runs as part of `bun run build` and fails the
build if any operator-only string reaches the public output. Both sites talk to
the same production deployment — the split is about what UI each one ships, not
about which data exists.

`https://exp-xearch.exe.xyz/` with no port is **not** the operator site. The
port the exe.dev proxy treats as this VM's primary is 4321, the search edge,
and it is the one port marked public. Every other port in 3000-9999, 8080
included, is reachable only by users with access to the VM
(https://exe.dev/docs/proxy.md). That is the whole access control on the
operator site: it has no login of its own.

Convex project: `xearch/xearch-next`. Deployment: `utmost-kudu-321` (production).

The pre-existing `xearch/xearch` production app was not changed. `.env.local` still selects local development. Production has separate auth keys and user records; local downloads and sessions were not migrated.

Deploy backend before publishing a matching frontend, with explicit production approval. Current main sends `includeStats` even when false; the older deployed backend does not accept that argument. Publishing only the new UI would break search.

A push to `main` also triggers the repository's deployment workflow after `Check` succeeds when `CONVEX_DEPLOY_KEY` is configured. Pushing, merging, and deploying are distinct authorizations; check this before pushing production changes.

For an approved manual deployment:

```sh
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx convex deploy
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx @convex-dev/static-hosting upload --build --prod --build-command 'bun run build'
```

`scripts/setup-production.mjs` copies selected provider variables from `.env.local`, not local capture settings. `--init-auth` is only for a fresh deployment and refuses existing keys. Secrets are passed over stdin, never printed.

AgentMail delivery events for the configured sender inbox are registered at `https://utmost-kudu-321.convex.site/agentmail/webhook`. The inbox-scoped API succeeded; the organization-level create route rejected the key. `AGENTMAIL_WEBHOOK_SECRET` is configured in production. Incoming email processing is not registered. No email was sent during setup.

Production imports use an outbound worker. At the September 20 integration check the VM worker, capture receiver, search API, continuous indexer, and nginx were running. Do not start a second worker or restart the active worker as routine verification. Follow the coordinated cutover steps below for any future worker move. The worker authenticates to production with `.local-captures/worker-token`, claims one due job at a time, downloads directly from x.md, and saves to the private loopback receiver. Only job metadata, receipts, and provider-throttle observations return to Convex. No inbound port or public tunnel is used. The UI marks the worker offline within 45 seconds without a heartbeat. Each poll also forwards what the worker just observed about the loopback capture receiver, which is the only thing that ever sees it (see "Service health" below). `scripts/setup-worker.mjs` configures its production credential without printing it.

`COLLECTOR_MODE=outbound` means Convex never talks to x.md or the capture receiver: `convex/importer.ts` returns before reading `RAW_CAPTURE_URL`/`RAW_CAPTURE_TOKEN`, so setting them on the production deployment does nothing. The worker reads them on its own machine, and the Connections UI labels that row "Download worker" rather than listing env vars. Worker liveness is expiry-driven: `worker.heartbeat` writes `collector.online` and schedules `worker.expire` 45 seconds later (`convex/worker.ts`), and the browser re-checks the disclosed `lastSeen` against its own clock. A Convex query does not re-run because time passed, so liveness must never be computed from `Date.now()` inside `integrations.configured`. Details: [the control plane](control-plane.md).

In outbound mode the worker is also the only production writer of `providerThrottleEvents`, through `worker.report`'s `"throttle"` event. Without it the Provider limits panel stays empty while x.md is refusing imports. Facts are captured from refusals only, so remaining allowance on a _successful_ call is still invisible, and `{ kind: "none" }` means nothing was observed, never "not throttled".

Tantivy retrieval is running. On September 20, authenticated search and pagination passed through Rust on loopback port 4320, nginx on port 4321, and the configured HTTPS search endpoint. Twelve pages passed the current response decoder, with diagnostics opt-in and no first/next-page overlap. The index reported 48,331 documents; all 321 retained raw captures had archive receipts. These are point-in-time observations, not a promise of complete account history.

At the September 20 check the hosted frontend and Convex backend were still older than main `e98e093`; a full authenticated UI journey with the new diagnostics is not yet verified. Main now does contain the publication sender (`search/crates/indexer/src/publish.rs`, merged in `4c13fe4`), so `publication.env` reaches a real consumer — but only on a checkout and installed binary built from that commit or later. Do not add a second sender. See `to-do.md` for the rollout, and [indexer operations](search-indexer.md) for the credential file and the `publish=enabled` startup check.

A TLS probe against the production route mutated no account state: an unknown handle returned HTTP 422 `rejected_invalid` and a wrong bearer returned HTTP 401 `rejected_unauthorized`. No real account has been published yet.

Firecrawl and OpenAI settings are configured, but paid calls have not been live-tested in production. Email sending requires a verified email identity; a guest session cannot send production email.

Starting or retrying an import (`jobs.start`/`jobs.retry`, any kind), reading web context or a linked page and "Help me search" (the `integrations.*` actions calling Firecrawl/x.md/OpenAI), and cancel/dismiss/restore on a job all require a signed-in OPERATOR, not merely a signed-in guest session — ordinary search stays public. `convex/access.ts`'s `requireOperator` accepts either of two independent paths:

- **The operator build's own token** (the primary path). The operator site is already restricted to exe.dev accounts with VM access — see the table above — so being on that site IS the operator proof, and no sign-in of any kind is asked for. The frontend threads a build-time token (`VITE_OPERATOR_TOKEN`, read by `src/operatorToken.ts`) through every gated call; `requireOperator` compares it against `OPERATOR_TOKEN` on the deployment with a constant-time comparison. The public build never has this token: `src/operatorToken.ts` is resolved to a stub with no reference to `VITE_OPERATOR_TOKEN` or the token itself (the same module-swap technique as `src/operatorSurface.ts`), and `scripts/check-public-bundle.mjs` fails the build if either the variable name or the string `operatorToken` reaches the public output.
- **The verified-email allowlist** (the fallback, kept only for the test suite and as a backstop). `requireOperator` checks the caller's verified email (from the stock Email OTP provider, `convex/auth.ts`) against `OPERATOR_EMAILS`, a comma-separated, case-insensitive list of addresses — or domains written as `@pcstyle.dev`, which admit every verified address on that domain — set on the production deployment. There is no email sign-in UI for this any more; every gated surface on the public site (the Import modal, web context, linked pages, "Help me search", cancel/dismiss) shows the same action-neutral copy, "This action runs from the operator dashboard."

Either way a real session is still required (even the token path needs a signed-in, possibly anonymous, caller to have a user id to record as `owner`). An anonymous guest with neither a matching token nor an allowlisted email is refused with the same message ("Sign in as an operator to import."), so neither the token nor the allowlist is ever confirmed or denied to the caller. This is authorization, not a quota — nothing about it counts or throttles requests, and it adds no rate limit on top of what x.md/Firecrawl/OpenAI themselves report.

The token file is `~/xearch-data/operator.env` (mode 0600, never committed), sourced by `scripts/deploy-operator-site.sh` the same way `xearch-search-indexer.service` sources `publication.env` — a plain `VITE_OPERATOR_TOKEN=<hex>` line, read into the build and never echoed or logged.

Rotation is genuinely two separate steps — republishing the operator site (which bakes a token into the served bundle) and setting `OPERATOR_TOKEN` on the Convex deployment (which is the one value it checks requests against) — and this deployment only ever holds one `OPERATOR_TOKEN` at a time. Whichever step happens second, there is a real gap where the live bundle's token (old or already-new) does not match what Convex has, and the token path fails for anyone on the operator site during that gap — the verified-email allowlist still works throughout, so this is a degraded operator UX, not a full outage, but it is not nothing. Two ways to rotate, in order of preference:

**Gapless, using `OPERATOR_TOKEN_PREVIOUS`** — `requireOperator` (convex/access.ts) also accepts a match against this optional second env var, so both the old (not yet republished) and new (already republished) bundle work at once during the rotation window:

```sh
NEW=$(openssl rand -hex 32)
OLD=$(grep -oP '(?<=VITE_OPERATOR_TOKEN=).*' ~/xearch-data/operator.env)
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx convex env set OPERATOR_TOKEN_PREVIOUS "$OLD"
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx convex env set OPERATOR_TOKEN "$NEW"
sed -i "s/^VITE_OPERATOR_TOKEN=.*/VITE_OPERATOR_TOKEN=$NEW/" ~/xearch-data/operator.env
bash scripts/deploy-operator-site.sh   # republishes with the new token baked in
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx convex env unset OPERATOR_TOKEN_PREVIOUS   # once the republish above is confirmed live
```

**Simple, accepting the gap** — skip `OPERATOR_TOKEN_PREVIOUS`; republish first (the outgoing bundle's old token stops matching for however long it takes `convex env set` to run right after), or set `OPERATOR_TOKEN` first (every operator site load fails the token path, falling back to the allowlist, until the republish below lands):

```sh
openssl rand -hex 32   # new token
$EDITOR ~/xearch-data/operator.env   # replace VITE_OPERATOR_TOKEN=... with the new value
bash scripts/deploy-operator-site.sh   # rebuilds and republishes with the new token baked in
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx convex env set OPERATOR_TOKEN
```

Verified public HTML/assets, production guest authentication plus saved-search create/read/remove, and one real production profile download through the outbound worker with a durable local receipt. Browser visual checks were unavailable during deployment.

## Service health

The dashboard reports two different things and must never confuse them:

- **Configured** (`convex/integrations.ts`'s `configured`) means an environment
  variable is set. That is all it means.
- **Health** (`serviceHealth`, written by `convex/health.ts`, read by
  `convex/summary.ts`'s `health` query) means something was actually observed
  working, with the time it last worked. A service that has never reported
  reads "No health report received yet" — nothing is seeded at deploy time to
  make the panel look populated.

Three writers, one row per service:

| Service    | Written by                                                                                     | Observation                                           |
| ---------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `indexer`  | the Rust indexer, once per poll pass (`search/crates/indexer/src/health.rs`)                   | the pass completed, or failed with its verbatim error |
| `search`   | a Convex cron every 2 minutes (`convex/crons.ts` → `health.probeSearch`)                       | `GET <SEARCH_API_URL origin>/health` answered `ok`    |
| `receiver` | the production download worker, on every poll (`scripts/production-worker.ts` → `worker:poll`) | `http://127.0.0.1:4319/health` answered               |

`lastSuccessAt` is only ever stamped from an observed success and is never
erased by a later failure; `lastError` carries the reporter's real error text.
Readings older than five minutes are shown as stale rather than trusted.

Report endpoint: `POST https://utmost-kudu-321.convex.site/service/health`,
bearer-authenticated, failing closed when unconfigured. Its capability token is
`SERVICE_HEALTH_TOKEN` on the Convex deployment (falling back to the legacy
`DATA_SERVICE_TOKEN`), set like any other secret:

```sh
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx convex env set SERVICE_HEALTH_TOKEN
```

The Rust indexer sends its heartbeat only when both `SERVICE_HEALTH_URL` (the
route above) and `SERVICE_HEALTH_TOKEN` (or `DATA_SERVICE_TOKEN`) are present in
its environment; without them the heartbeat is a complete no-op and the indexer
imports exactly as before. `xearch-search-indexer.service` already reads
`%h/xearch-data/search/publication.env`, so both variables belong in that file
(mode 0600, never committed) next to the publication credentials. A heartbeat
can never fail or interrupt an import pass, and the worker's health report can
never fail a poll or move a job's status.

Neither the indexer heartbeat nor the search cron has been observed running
against the production deployment yet: `SERVICE_HEALTH_TOKEN` is not set there,
and nothing in this change deploys itself.

## Automatic account discovery

`scripts/discover-accounts.mjs` expands the indexed accounts to the people they
interact with most. It reads the raw captures already on this machine (no
provider is contacted), counts replies, quotes, @mentions and reposts from
indexed accounts per target handle, and queues an account-history import for
every target at or above `DISCOVERY_MIN_INTERACTIONS` (default 100; on 2026-09-24 the captures gave 535 accounts at 25, 218 at 50, 86 at 100, 25 at 200) that is
neither indexed nor already the subject of a bulk import in any state. The
threshold is the relevance criterion; there is deliberately no per-run cap
(see "Rate limiting" in AGENTS.md). Discovered runs are tagged
(`jobs.origin = "discovered"`, `jobs.discoveredFrom`) and the dashboard says
which accounts led to them.

```sh
# Rank only, start nothing:
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 node scripts/discover-accounts.mjs
# Queue the imports:
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 node scripts/discover-accounts.mjs --apply
```

It goes through `convex run` on internal functions, so it needs the deploy
key the VM already uses and neither a browser session nor the operator token.
`deploy/systemd/xearch-discover.timer` runs it hourly once enabled
(`systemctl --user enable --now xearch-discover.timer`); it logs to
`~/xearch-data/logs/discover.log`. Enabling the timer is a deliberate step:
every run can start paid imports.

## VM services

The VM runs the static frontend and raw capture receiver and, after a coordinated
cutover from the Mac, the outbound production worker as user-level systemd
services, alongside the Rust Tantivy API and continuous indexer. Convex stays on
the existing hosted production deployment; the VM does not host local Convex or
Elasticsearch.

Production code lives in `/home/exedev/xearch-worker`; persistent captures, index,
archive, and registry live under `/home/exedev/xearch-data`. Preserve them across
updates. The API listens on `127.0.0.1:4320`; nginx proxies search on port 4321.

The unsafe installed updater was disabled/stopped on September 20. Install and
verify the corrected `scripts/vm-update.sh` before re-enabling
`xearch-update.timer`. The corrected updater only restarts already-active search
services, disables legacy reindex triggers, republishes the operator site when
application code changed (`scripts/deploy-operator-site.sh`, a directory swap
under nginx), and records successful application for retries. It does not
deploy Convex or the public site, and never restarts worker/capture.
Never run legacy reindexing alongside the continuous watcher.

The following unit installation commands are for initial provisioning only. Do not overwrite the existing production units or their operator-configured paths/drop-ins during routine updates:

```sh
install -d -m 700 ~/.config/systemd/user .local-captures/logs
install -m 600 deploy/systemd/xearch-capture.service ~/.config/systemd/user/
install -m 600 deploy/systemd/xearch-production-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now xearch-capture.service
```

Do not enable or start `xearch-production-worker.service` until the Mac worker is
confirmed stopped and any final capture sync is complete. At cutover:

```sh
systemctl --user enable --now xearch-production-worker.service
```

Publish the operator site:

```sh
bash scripts/deploy-operator-site.sh
```

It builds with `VITE_XEARCH_OPERATOR=1` against the production deployment and
refuses to publish a tree with no dashboard in it. Each build lands in
`$ROOT/releases/<utc-stamp>/` and `$ROOT/dist` is a symlink onto the current
one, so publication is a single rename and a request never lands on a
half-copied tree. nginx resolves its document root per request and serves from
disk, so publishing needs no restart.

The three newest releases are kept, plus whichever one `dist` points at. The
script prints the exact rollback command for the release it replaced; it is
another symlink swap:

```sh
ROOT=~/xearch-data/hosting
ln -sfn "releases/<stamp>" "$ROOT/dist.incoming" && mv -T "$ROOT/dist.incoming" "$ROOT/dist"
```

Installed nginx uses the prefix `/home/exedev/xearch-data/hosting/`, so its
`root dist` resolves to `/home/exedev/xearch-data/hosting/dist`, not either
checkout's `dist/`. That document root was absent from the September 20 check
until September 21, and the VM frontend returned 500 for the whole period.
Convex static-hosting publication does not update nginx's files, and this
script does not touch Convex.

To verify a public build without publishing anything. Run the steps
separately: `bun run build` chains three commands, and `bun run` appends
trailing arguments to the last one, so `bun run build --outDir ...` would hand
`--outDir` to the bundle checker and leave Vite writing to `dist/`.

```sh
bunx tsc --noEmit
VITE_CONVEX_URL=https://utmost-kudu-321.convex.cloud bunx vite build --outDir .local-hosting/build-check/dist
node scripts/check-public-bundle.mjs .local-hosting/build-check/dist
```

Long-running services have restart policies; this does not prove health or
frontend publication. The receiver listens only on `127.0.0.1:4319`.
Production worker/capture logs are under
`/home/exedev/xearch-data/.local-captures/logs/`; nginx logs are under
`/home/exedev/xearch-data/hosting/logs/`. These
directories and their files must remain owner-only. Inspect status without
printing credentials:

```sh
systemctl --user status xearch-capture.service
systemctl --user status xearch-production-worker.service
systemctl --user status xearch-frontend.service
systemctl --user status xearch-search-indexer.service
curl --fail --silent http://127.0.0.1:4319/health
curl --fail --silent http://127.0.0.1:4320/health
curl --fail --silent http://127.0.0.1:4321/health
curl --fail --silent http://127.0.0.1:8080/
ss -ltnp 'sport = :4319'
```

Confirm which end the indexer picked up for publication without reading the
credential file back. The watcher logs `publish=enabled` or
`publish=disabled` at startup:

```sh
journalctl --user -u xearch-search-indexer.service | grep 'indexer resolved'
```

The credentials live in `~/xearch-data/search/publication.env` (mode 0600),
loaded by `deploy/systemd/xearch-search-indexer.service` with a leading `-`
so a missing file is not an error — the service starts and publication simply
stays off. `PUBLICATION_UPDATE_URL` must be `https://` for a real deployment:
the sender refuses a non-loopback `http://` endpoint outright, because every
update carries the service token in an `Authorization: Bearer` header. A
refused endpoint logs `indexer publish: disabled.` with the variable name and
the offending host, and never the token itself. Full setup:
[indexer operations](search-indexer.md) "Publishing to Convex".

The committed units are specific to the `exedev` checkout path on this VM. If the
repository or Bun executable moves, update both the committed and installed
units together.
