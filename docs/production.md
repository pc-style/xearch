# Production deployment

VM frontend (private exe.dev proxy): https://exp-xearch.exe.xyz/

Dashboard: https://exp-xearch.exe.xyz/?dashboard=1

Hosted Convex frontend: https://utmost-kudu-321.convex.site

Convex project: `xearch/xearch-next`. Deployment: `utmost-kudu-321` (production).

The pre-existing `xearch/xearch` production app was not changed. `.env.local` still selects local development. Production has separate auth keys and user records; local downloads and sessions were not migrated.

Deploy backend and frontend explicitly:

```sh
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx convex deploy
CONVEX_DEPLOYMENT=prod:utmost-kudu-321 bunx @convex-dev/static-hosting upload --build --prod --build-command 'bun run build'
```

`scripts/setup-production.mjs` copies selected provider variables from `.env.local`, not local capture settings. `--init-auth` is only for a fresh deployment and refuses existing keys. Secrets are passed over stdin, never printed.

AgentMail delivery events for the configured sender inbox are registered at `https://utmost-kudu-321.convex.site/agentmail/webhook`. The inbox-scoped API succeeded; the organization-level create route rejected the key. `AGENTMAIL_WEBHOOK_SECRET` is configured in production. Incoming email processing is not registered. No email was sent during setup.

Production imports use an outbound worker. The VM worker unit is installed but was inactive at the September 19 cleanup check; the frontend and capture receiver were active. This does not confirm whether the old Mac worker has stopped. Follow the coordinated cutover steps below before starting the VM worker. The worker authenticates to production with `.local-captures/worker-token`, claims one due job at a time, downloads directly from x.md, and saves to the private loopback receiver. Only job metadata, receipts, and provider-throttle observations return to Convex. No inbound port or public tunnel is used. `scripts/setup-worker.mjs` configures its production credential without printing it.

`COLLECTOR_MODE=outbound` means Convex never talks to x.md or the capture receiver. Setting `RAW_CAPTURE_URL` / `RAW_CAPTURE_TOKEN` on the production deployment does nothing; the worker reads those on this machine. The Connections UI labels that row "Download worker". Worker liveness is expiry-driven: each heartbeat writes `collector.online` and schedules a flip to offline 45 seconds later (`convex/worker.ts`). A Convex query does not re-run because time passed, so liveness must not be computed from `Date.now()` inside `integrations.configured`. Details: [control plane](control-plane.md).

The worker is also the only production writer of `providerThrottleEvents`. Without `worker.report` `"throttle"`, the Provider limits panel stays empty while x.md is refusing imports. A 429 is recorded; remaining allowance on a _successful_ call is still invisible.

Search retrieval remains disconnected until `SEARCH_API_URL` serves the app contract. The indexer can now _report_ searchable state to Convex (`POST /publication/update`); that sender is off unless `~/xearch-data/search/publication.env` sets `PUBLICATION_UPDATE_URL` and a token — see [indexer operations](search-indexer.md). A TLS probe (unknown handle → 422, wrong bearer → 401) mutated no account state. No real account has been published. Firecrawl and OpenAI settings are configured, but paid calls have not been live-tested in production. Email sending requires a verified email identity; a guest session cannot send production email.

Verified public HTML/assets, production guest authentication plus saved-search create/read/remove, and one real production profile download through the outbound worker with a durable local receipt. Browser visual checks were unavailable during deployment.

## VM services

The VM runs the static frontend and raw capture receiver and, after a coordinated
cutover from the Mac, the outbound production worker as user-level systemd
services. Convex stays on the existing hosted production deployment. These
services do not host a development server, Convex, Elasticsearch, or another
search engine.

Install the unit files from the repository and create the private log directory:

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

Build the frontend against the existing production Convex deployment without
editing the existing environment files, then install its service:

```sh
VITE_CONVEX_URL=https://utmost-kudu-321.convex.cloud bun run build
install -d -m 700 .local-hosting/logs
install -m 600 deploy/systemd/xearch-frontend.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now xearch-frontend.service
```

The frontend listens on port 8080 for the exe.dev HTTPS proxy. Configure the
documented private proxy with `ssh exe.dev share port exp-xearch 8080`. Do not
make the proxy public without an explicit launch decision. The resulting private
URL is `https://exp-xearch.exe.xyz/`.

All services restart automatically. The receiver listens only on
`127.0.0.1:4319`. Worker/capture logs are written beneath
`.local-captures/logs/`; nginx logs are under `.local-hosting/logs/`. These
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

Confirm the indexer picked up publication credentials without reading the env file:

```sh
journalctl --user -u xearch-search-indexer.service | grep 'indexer resolved'
```

Expect `publish=enabled` or `publish=disabled`. The credentials file is
`~/xearch-data/search/publication.env` (mode 0600), loaded by
`deploy/systemd/xearch-search-indexer.service`. A missing file is not an error;
publication stays off.

The committed units are specific to the `exedev` checkout path on this VM. If the
repository or Bun executable moves, update both the committed and installed
units together.
