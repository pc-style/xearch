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

Production imports use an outbound worker. At the September 20 integration check the VM worker, capture receiver, search API, continuous indexer, and nginx were running. Do not start a second worker or restart the active worker as routine verification. Follow the coordinated cutover steps below for any future worker move. The worker authenticates to production with `.local-captures/worker-token`, claims one due job at a time, downloads directly from x.md, and saves to the private loopback receiver. Only job metadata, receipts, and provider-throttle observations return to Convex. No inbound port or public tunnel is used. The UI marks the worker offline within 45 seconds without a heartbeat. `scripts/setup-worker.mjs` configures its production credential without printing it.

`COLLECTOR_MODE=outbound` means Convex never talks to x.md or the capture receiver: `convex/importer.ts` returns before reading `RAW_CAPTURE_URL`/`RAW_CAPTURE_TOKEN`, so setting them on the production deployment does nothing. The worker reads them on its own machine, and the Connections UI labels that row "Download worker" rather than listing env vars. Worker liveness is expiry-driven: `worker.heartbeat` writes `collector.online` and schedules `worker.expire` 45 seconds later (`convex/worker.ts`), and the browser re-checks the disclosed `lastSeen` against its own clock. A Convex query does not re-run because time passed, so liveness must never be computed from `Date.now()` inside `integrations.configured`. Details: [the control plane](control-plane.md).

`scripts/setup-worker.mjs` is what sets production `COLLECTOR_MODE=outbound` and `COLLECTOR_TOKEN` (from `.local-captures/worker-token`) on `utmost-kudu-321`. Do not copy those onto a local anonymous deployment: `bun run env:sync` deliberately omits them, and a local checkout that inherited `outbound` would make `importer.ts` no-op with no VM worker polling. `jobs.start` still requires `X_MD_API_KEY` on the Convex deployment even in outbound mode; the worker's own key lives in the VM `.env.local` and is a separate copy.

## Outbound collector and accounts

The only code that inserts an `accounts` row is `jobs.finish` → `upsertAccount`, and only when `finish` is called with a `profile`. Production never does that.

- `convex/importer.ts` (the path that _does_ pass a validated profile) returns immediately when `COLLECTOR_MODE=outbound`.
- `convex/worker.ts` `report` `"finish"` has no `profile` argument, so it cannot call `upsertAccount` even if a caller sent one.
- `scripts/production-worker.ts` strips the profile `collectXmd` returned: `const { profile: _rawProfile, ...summary } = result` then `report({ event: "finish", ...summary })`.
- `worker.report` `"identity"` only runs `jobs.pinIdentity` (`jobs.expectedUserId`). That is not an account row.

Identity pin ≠ account row. A profile-kind production download is a capture receipt, not an `accounts` row. Publication cannot invent the missing row (`422 rejected_invalid`). Jobs that already finished will not re-report; installing a worker that later sends `profile` does not backfill them. A later approved bulk import is required once that path exists. Handle validation (`/^[A-Za-z0-9_]{1,15}$/`) and https-only avatars are enforced only on the in-Convex finish path, which production does not run.

| Symptom                                                      | Not this                                          | Actually this                                       |
| ------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------- |
| Account library empty, Indexed people 0                      | "nothing imported yet"                            | `jobs` / `receipts` rows exist; `accounts` does not |
| `POST /publication/update` → 422 `No known account matches…` | sender or token misconfig (a wrong bearer is 401) | receiver has no row to resolve                      |
| Profile job complete with a local receipt                    | the account is in the library                     | capture of `/profiles/:handle` only                 |
| `jobs.expectedUserId` set on a bulk run                      | `upsertAccount` ran                               | identity was pinned; finish had no profile          |

In outbound mode the worker is also the only production writer of `providerThrottleEvents`, through `worker.report`'s `"throttle"` event. Without it the Provider limits panel stays empty while x.md is refusing imports. Facts are captured from refusals only, so remaining allowance on a _successful_ call is still invisible, and `{ kind: "none" }` means nothing was observed, never "not throttled".

Tantivy retrieval is running. On September 20, authenticated search and pagination passed through Rust on loopback port 4320, nginx on port 4321, and the configured HTTPS search endpoint. Twelve pages passed the current response decoder, with diagnostics opt-in and no first/next-page overlap. The index reported 48,331 documents; all 321 retained raw captures had archive receipts. These are point-in-time observations, not a promise of complete account history.

At the September 20 check the hosted frontend and Convex backend were still older than main `e98e093`; a full authenticated UI journey with the new diagnostics is not yet verified. Main now does contain the publication sender (`search/crates/indexer/src/publish.rs`, merged in `4c13fe4`), so `publication.env` reaches a real consumer — but only on a checkout and installed binary built from that commit or later. Do not add a second sender. See `to-do.md` for the rollout, and [indexer operations](search-indexer.md) for the credential file and the `publish=enabled` startup check.

A TLS probe against the production route mutated no account state: an unknown handle returned HTTP 422 `rejected_invalid` and a wrong bearer returned HTTP 401 `rejected_unauthorized`. No real account has been published yet.

Firecrawl and OpenAI settings are configured, but paid calls have not been live-tested in production. Email sending requires a verified email identity; a guest session cannot send production email.

Verified public HTML/assets, production guest authentication plus saved-search create/read/remove, and one real production profile download through the outbound worker with a durable local receipt. Browser visual checks were unavailable during deployment.

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
systemctl --user status xearch-search-indexer.service
curl --fail --silent http://127.0.0.1:4319/health
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
