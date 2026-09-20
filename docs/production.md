# Production deployment

VM frontend (private exe.dev proxy): https://exp-xearch.exe.xyz/

Dashboard: https://exp-xearch.exe.xyz/?dashboard=1

Hosted Convex frontend: https://utmost-kudu-321.convex.site

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

Production imports use an outbound worker. At the September 20 integration check the VM worker, capture receiver, search API, continuous indexer, and nginx were running. Do not start a second worker or restart the active worker as routine verification. Follow the coordinated cutover steps below for any future worker move. The worker authenticates to production with `.local-captures/worker-token`, claims one due job at a time, downloads directly from x.md, and saves to the private loopback receiver. Only job metadata and receipts return to Convex. No inbound port or public tunnel is used. The UI marks the worker offline within 45 seconds without a heartbeat. Each poll also forwards what the worker just observed about the loopback capture receiver, which is the only thing that ever sees it (see "Service health" below). `scripts/setup-worker.mjs` configures its production credential without printing it.

Tantivy retrieval is running. On September 20, authenticated search and pagination passed through Rust on loopback port 4320, nginx on port 4321, and the configured HTTPS search endpoint. Twelve pages passed the current response decoder, with diagnostics opt-in and no first/next-page overlap. The index reported 48,331 documents; all 321 retained raw captures had archive receipts. These are point-in-time observations, not a promise of complete account history.

The hosted frontend and Convex backend were still older than main `e98e093`; a full authenticated UI journey with the new diagnostics is not yet verified. Main's indexer now carries the publication sender; `publication.env` supplies its endpoint and token. No account has been published from it yet, so dashboard publication counts stay at zero until a real update lands. See `to-do.md` for the rollout and branch handoff.

Firecrawl and OpenAI settings are configured, but paid calls have not been live-tested in production. Email sending requires a verified email identity; a guest session cannot send production email.

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

## Queued indexer work

The dashboard Overview tiles split two queues that must not be added together:

- **This app's queue** (waiting/active downloads, saved captures awaiting
  indexing, failed & retryable) comes from our jobs and receipts.
- **Indexer-reported queued work** (Queued posts / Queued captures / Queued
  indexer jobs) comes from `accountPublications.pendingWork` on applied
  publication updates, one labelled unit at a time. Silence is "not yet
  known", not zero. A reported 0 is a real 0.

The current Rust publication sender does not emit `pendingWork`, so those
three tiles stay unknown even after heartbeats are wired. That is expected,
not a missing Convex row. See `docs/publication-contract.md`
"Dashboard-facing shapes".

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
services, disables legacy reindex triggers, and records successful application
for retries. It does not deploy Convex/frontend or restart worker/capture.
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

Verify a production-bound frontend build without changing existing environment
files or overwriting a live `dist/`:

```sh
VITE_CONVEX_URL=https://utmost-kudu-321.convex.cloud bun run build --outDir .local-hosting/build-check/dist
```

This only builds; it does not publish. Installed nginx uses the prefix
`/home/exedev/xearch-data/hosting/`, so its `root dist` resolves to
`/home/exedev/xearch-data/hosting/dist`, not either checkout's `dist/`. That document
root was absent at the September 20 check and the documented VM frontend URL
returned 404. After approved backend deployment, publish the matching build to
that root and verify HTML and assets separately. Convex static-hosting publication
does not update nginx's files.

The frontend listens on port 8080 for the exe.dev HTTPS proxy. Configure the
documented private proxy with `ssh exe.dev share port exp-xearch 8080`. Do not
make the proxy public without an explicit launch decision. The resulting private
URL is `https://exp-xearch.exe.xyz/`.

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
curl --fail --silent http://127.0.0.1:4319/health
curl --fail --silent http://127.0.0.1:4320/health
curl --fail --silent http://127.0.0.1:4321/health
curl --fail --silent http://127.0.0.1:8080/
ss -ltnp 'sport = :4319'
```

The committed units are specific to the `exedev` checkout path on this VM. If the
repository or Bun executable moves, update both the committed and installed
units together.
