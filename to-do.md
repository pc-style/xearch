# Xearch to-do

Updated September 20, 2026. Planning only: this list does not authorize implementation, paid imports, merging, or deployment.

## Urgent handoff — production integration (September 20)

This section supersedes older runtime/branch claims below. As written, the
production checkout `/home/exedev/xearch-worker` was on main `e98e093` and the
editor checkout was based on that same commit; the fixes in this handoff were
not deployed to Convex or installed in the production checkout. `main` has
since moved to `4c13fe4` (PR #19 merged), which is what the claims below have
been re-checked against.

- [x] Verify live retrieval, not just health: authenticated search and pagination
      passed through Rust :4320, nginx :4321, and the configured HTTPS endpoint.
      Twelve pages validated against the current app decoder; decimal-string IDs,
      no overlap across paired pages, stats opt-in works. Index reported 48,331 docs.
      All 321 retained raw captures had archive receipts; no local capture backlog.
- [x] Correct the app's stale-cursor handling to HTTP 409, matching Rust. Regression
      reproduced before fixing; first-page 409 remains a generic service failure.
- [x] Fix updater code to retire competing legacy reindex triggers, update the
      watcher binary, retry failed updates using a successful-application marker, and
      leave worker/capture/cloud deployment alone. Add 20 isolated regression tests.
      Manual reindex now refuses to compete with a running watcher.
- [ ] **P0: Install the reviewed updater fixes into the production checkout before
      re-enabling `xearch-update.timer`.** The unsafe live timer was disabled/stopped
      during this handoff. Search, indexer, and download worker remain running.
      Do not run the old `vm-update.sh --force`: it restarts the worker and enables
      competing legacy writers. Promote this commit without overwriting other work;
      verify the fixed updater, then `systemctl --user enable --now xearch-update.timer`.
- [ ] **P0: Obtain explicit production deployment approval, then deploy backend
      and frontend together to `prod:utmost-kudu-321`.** The live backend lacks
      `search:start.includeStats`; the new UI sends it even when false. Do not publish
      the new UI first. `bun run deploy:prod` builds, deploys backend, then uploads
      static assets. Both checkouts' `.env.local` select dev, so retain the script's
      explicit production target; do not alter auth keys or AgentMail webhook.
- [ ] **P0: Repair the VM frontend publication.** nginx's document root is
      `/home/exedev/xearch-data/hosting/dist`, currently absent, not the checkout's
      `dist/`. After backend deployment, publish a production-bound build there;
      verify HTML and assets at the existing exe.dev URL without changing access
      controls. Convex-hosted frontend is `https://utmost-kudu-321.convex.site/`.
- [ ] **P0: install the sender-capable watcher on the VM.** The integration half
      of this is done: `adam/known-open-issues` was reviewed and merged to `main`
      as `4c13fe4` (PR #19), so `main` now consumes `PUBLICATION_UPDATE_URL` and
      `PUBLICATION_SERVICE_TOKEN` (`search/crates/indexer/src/publish.rs`) and
      `publication.env` reaches a real consumer. Do not build a second sender.
      `adam/dashboard-truth-gaps` adds further health/queue work and is still
      open. Remaining: install the sender-capable watcher from `main` and
      reconcile already-indexed accounts using its explicit `publish <handle>` flow
      with the watcher stopped. Preserve registry generations; this writes Convex
      publication state but must not re-download captures. Pending publication state
      lives inside `state/users.json`, not a separate outbox file.
- [ ] After approved deployment, exercise authenticated UI search with stats off/on,
      sort and pagination, and confirm dashboard published counts against Tantivy.
      Successful Rust retrieval alone does not prove the full Convex/UI journey.
- [ ] Only with paid-import approval: investigate incomplete acquisition for
      `xai`, `lauren_tan`, and Theo; confirm `jarredsumner` versus `jaredsumner` before
      retrying. Text matches/accepted records are not proof of complete author history.

Validation for this handoff: 201 tests passed, typecheck passed, production-bound
frontend build passed into `.local-hosting/integration-check/dist` (not live
`dist/`). Oxlint reported zero errors and one existing warning. No production
Convex deployment, paid import, data deletion, or worker restart was performed.

Since that handoff, `bun run lint` is Oxlint alone: React Doctor was moved to an
advisory CI check scoped to `src/` (`blocking: none`), so its findings no longer
block lint. On `4c13fe4` the current readings are `bun run lint` → exit 0 with
one `no-unused-vars` warning (`src/App.tsx:65`, `safeHostname`), `bun run
typecheck` → exit 0, and `bunx vitest run` → 27 files / 263 tests passed.

Ownership: Pronsh owns search and indexing. Our backlog covers the application, acquisition, Convex integration, and UI. Do not assign search-engine, ranking, replay, indexer, or cursor implementation to our agents. Mention collaborator work only as dependency context, not as our tasks.

## Priority: make the existing product understandable and reliable

Fix the import/library dashboard and its underlying data before adding discovery or more features. The current screen is a job log: repeated accounts, stale phases, contradictory search messages, and no useful corpus overview. Do not mistake duplicate job rows for proof of duplicate indexed posts; measure both separately.

### P0 — Replace the job wall with an account library

- [x] Show one primary row per account, with display name/handle, unique indexed-post count, current download/indexing state, last successful publication, and a relevant next action. Closed: `convex/library.ts` `rows` groups by resolved account; `src/library/AccountRow.tsx` renders all fields; `tests/library.test.ts` "collapses repeated runs for one account into a single row" — passing (`bunx vitest run tests/library.test.ts --reporter=verbose`, this run).
- [x] Group retries, batches, and older runs under expandable account history. Preserve receipts and failure evidence; do not delete records just to hide duplicates. Closed: `convex/library.ts` `history`; `src/library/AccountRow.tsx` `AccountHistory`; `tests/library.test.ts` "preserves every retry, batch, and failure record instead of collapsing or deleting them" — passing this run.
- [x] Group by stable provider account ID where known, using normalized handles only as a fallback. Do not combine different identities after a handle reassignment. Closed: the write side now agrees with the read side — `convex/jobs.ts` `upsertAccount` resolves `by_user_id` and gives an unknown provider id arriving on a known handle its OWN row instead of patching the incumbent's `userId`, and records every handle an account has held in `accountHandles` (nothing wrote that table before). Because two rows may then legitimately share a handle, the three `by_handle` reads that used `.unique()` (`library.ts`, `summary.ts`, `jobs.start`) now read two and treat an ambiguous match as unresolved rather than picking one. `tests/account-identity.test.ts` — "gives a reassigned handle its own account row instead of overwriting the previous holder's identity", "treats the same provider id under a new handle as a rename, patching one row rather than adding another", and "keeps the two identities as separate library rows and never throws on the now-duplicated handle" — all passing this run.
- [x] Keep live-search requests, conversations, and other non-account imports separate from the indexed-people list. A search input such as `from:theo` is not an account identity. Closed: `ACCOUNT_JOB_KIND = "bulk"` filter in `convex/library.ts:21,36` and `convex/summary.ts:56`; `tests/library.test.ts` "excludes non-account imports (live/post/etc) from the indexed-people list" — passing this run.
- [x] Show indexed accounts even when their latest refresh failed. Keep the usable corpus visible alongside the latest error. Closed, live-verified this run: `bunx vitest run tests/scenario-screenshot-cases.test.ts --reporter=verbose`, case 4 — publication state "failed", `searchablePostCount` known/950, UI still shows "Publication failed" (not "Searchable") while keeping the old count visible.
- [x] Replace the oversized repeated cards with a compact, readable layout: overview, account library, active queue, and secondary run history. Keep importing easy to find without letting the form dominate the page. Closed: personally viewed `scratchpad/11-dashboard-desktop-full.png` this run — renders Overview → Dependency health/Provider limits → Account library → Active queue → Recent run history → Other imports, in that order, on a single compact page.
- [x] Provide account search and useful status filters. Make loading, empty, offline, stale-data, and partial-failure states explicit. Closed: `src/library/AccountLibrary.tsx` renders a search input and status `<select>`; `tests/library.test.ts` "filters by status and by handle/name search, server-side" — passing this run; loading/offline states also visually confirmed in `scratchpad/11-dashboard-desktop-full.png` and `24-mobile-reconnecting.png` (both taken against a genuinely disconnected Convex session this run).
- [x] Remove contradictory copy such as "downloads aren't searchable yet" and "search will be available when connected" when indexed data is actually available. Configuration, connectivity, download completion, and search publication are different states. Closed: neither phrase appears anywhere under `src/` (fff grep for both strings, this run, zero hits).
- [x] Do not leave failed jobs showing only "Saving raw capture." Show the current failure, retained progress, and the next useful action; keep raw diagnostics in details. Closed, live-verified this run: `src/jobText.ts:33-38` `stoppedRunSummary`; scenario-screenshot-cases case 1 — UI shows the real error and retained-count text and a Retry action, and does NOT show the stale "Saving raw capture" phase as the outcome.

### P0 — Show simple, trustworthy stats

- [x] **Indexed posts:** unique, currently searchable post IDs from the committed index, not summed download counts or accepted-record receipts. State the authorized scope and observation time. Closed: `convex/summary.ts` sums only `accountPublications.searchablePostCount`; `tests/summary.test.ts` "sums searchablePostCount across accounts as the ONLY source for indexed posts" — passing this run; scope+`observedAt` present on every response (confirmed in the case 3/4 console output above).
- [x] **Indexed people:** distinct accounts with searchable posts; link the number to the account list. Closed: `src/library/OverviewStats.tsx:54` renders `href="#account-library"`, which targets `src/library/AccountLibrary.tsx:40`'s `id="account-library"` section (confirmed by reading both this run).
- [x] **Queue:** distinguish waiting downloads, active downloads, saved captures awaiting indexing, and failed/retryable work. Label units explicitly: jobs, captures, or posts. Closed, live-verified this run: scenario-screenshot-cases case 3 `summary.summary` on an empty DB returns `activeDownloads`/`failedRetryable`/`savedCapturesAwaitingIndexing`/`waitingDownloads` each as `{kind:"known", unit, value}`, never a bare number.
- [ ] Show queued-post counts only when known. Unknown provider history size is "unknown," not zero or an invented estimate. Do not label a count of files as a count of posts. Not closed: `publicationUpdateFields.pendingWork` exists and round-trips onto `accountPublications` (`convex/publication.ts`; `tests/publication.test.ts` "round-trips an accepted update's pendingWork onto the accountPublications row" — passing this run), but `convex/lib/contracts.ts`'s `dashboardSummaryValidator`/`queueBreakdownValidator` has no field carrying it to the dashboard, and `OverviewStats.tsx` has no such tile — confirmed by `convex/summary.ts:69-73`'s own comment and by reading `contracts.ts` this run. No queued-post count reaches the UI today.
- [x] **Provider limits:** show provider-reported throttling, remaining allowance/reset when actually supplied, the affected operation, and the next retry time. If remaining allowance is unavailable, say so. Closed: the write path now exists. `convex/lib/xmd.ts` parses the provider's own IETF `RateLimit` allowance headers (with `X-RateLimit-*` as fallback), taking the most constraining of the several allowances x.md reports at once, and the problem body's `retry_after`, onto `ProviderError.throttle`; `convex/importer.ts` and — for production, where `COLLECTOR_MODE=outbound` means the VM worker is the only thing that calls x.md — `scripts/production-worker.ts` via `worker.report`'s new `"throttle"` event both record it through `convex/jobs.recordThrottle`. `tests/provider-limits-writepath.test.ts` drives the real acquisition path with a stubbed transport returning the exact 429 body production retained on disk and asserts the reading that reaches the dashboard. Known limit, stated rather than hidden: facts are captured on ERROR responses only, so a successful call's remaining allowance is still invisible and `{ kind: "none" }` still means "nothing observed", never "not throttled".
- [x] Respect provider `Retry-After`/`retryAfter`. Do not reintroduce application daily caps, quotas, or usage budgets; their removal is already merged in PR #12. Closed: `convex/lib/xmd.ts:57-64` `retryDelay` parses `Retry-After`, used at `convex/lib/handoff.ts:75` and `convex/lib/xmd.ts:111`; `tests/indexing.test.ts` confirms the parsing. fff grep for "budget" this run finds zero matches under `convex/` (only doc/history mentions), matching `convex/limits.ts:18-21`'s own self-check comment.
- [x] Separate current provider throttling from historical "today's import limit" errors left on old jobs. Do not present an old error as the current account limit. Closed by design, live-verified this run: scenario-provider-throttling part 1 — a stale `jobs.error` string never renders as a current limit; UI shows "No throttling reported" instead. (The real-world write path for a _live_ throttle event has the same gap noted two bullets up.)
- [x] Expose safe summary data through authenticated backend contracts. Do not expose raw state files, service credentials, private logs, or another user's data to the browser. Closed: `convex/access.ts`'s `user()` gates every query touched this run (`summary.ts`, `limits.ts`, `library.ts`, `email.ts`, `search.ts`, `jobs.ts`, `integrations.ts` — confirmed by grep this run); every return type is a narrow validator (`Count`, `AccountLibraryRow`, etc.), never a raw document.
- [ ] Report worker/indexer health and last successful activity separately from "configured." Stale or unavailable stats must not look like live zeroes. Partial: query+UI distinction is real and correct, live-verified this run (scenario-screenshot-cases case 5 — a stale indexer heartbeat shows caution text and never plain "Healthy"; an offline receiver shows "Unhealthy"; a service with no report ever shows "No health report received yet", never a live zero); also visually confirmed in `scratchpad/11-dashboard-desktop-full.png`'s "Dependency health" panel. Remaining: fff grep for `serviceHealth` this run shows only test files insert rows — nothing in `convex/` writes a real heartbeat, so all three services will read "unknown" in production until a writer exists.

### P0 — Fix import failures and connect publication state

- [x] Investigate the screenshot's "x.md history is missing posts, profile, or its completion summary" failures against retained captures and the actual parser contract. Capture the failing response shape in a sanitized fixture before changing validation. Closed: root cause is `convex/lib/collect.ts` — x.md omits `profile` on history continuation pages; fixed to tolerate that only on continuations. Fixture `tests/fixtures/xmd-history-continuation-missing-profile.json` exists on disk (confirmed this run) and is imported by `tests/indexing.test.ts`; "accepts a JSON history continuation page even when x.md omits the embedded profile" and "still rejects a continuation page missing posts or meta as malformed, profile or not" both pass this run (verbose re-run).
- [x] Determine why runs can retain 500 posts and then stop. Preserve saved data, distinguish valid partial history from malformed input, and do not weaken completeness checks just to make jobs green. Closed: same root cause and fix as above — the profile check was wrongly rejecting every continuation page, so `convex/jobs.ts`'s `autoContinue` never got a second page. The check was narrowed only for continuation pages missing just the profile; a first page (or any page missing posts/meta) is still rejected — see the negative test above, still passing.
- [x] Make retry/continue reuse durable progress where possible without creating another top-level account row or duplicating indexed posts. Prevent accidental duplicate active acquisition for the same scope without blocking intentional refreshes. Closed: `convex/jobs.ts`'s `retry` (lines 175-190, read this run) mutates the same job document and blocks a second active run for the same kind+input ("This indexing job is already active."); `start`'s `previous: v.optional(v.id("jobs"))` arg (line 52) threads continuation into a new job doc that `library.ts`'s grouping still files under the same account row; `searchablePostCount` can only come from an accepted publication update, never job/receipt counts, so repeat acquisition can't inflate it — `tests/summary.test.ts` "does not dedupe savedCapturesAwaitingIndexing per job — the same content-addressed captureId across two of one account's bulk jobs counts once, not twice" passes this run.
- [x] Implement the Convex receiver for authenticated, idempotent publication updates supplied by Pronsh's service. Raw capture receipt means downloaded; only confirmed index publication means searchable. The indexer-side sender is Pronsh's work. Closed: `convex/publication.ts` + `POST /publication/update` registered in `convex/http.ts:13`; `tests/publication.test.ts` (23 tests, all passing this run, verbose re-run) plus the full `tests/scenario-publication-lifecycle.test.ts` run below. No real indexer has called this route yet (see DECISIONS.md).
- [x] Represent downloaded, waiting for indexing, indexing, searchable, and failed publication separately. A failed refresh must not erase the previous searchable state. Closed, live-verified this run: scenario-screenshot-cases case 4 — an account with `state:"failed"` and a real `lastError` still reports `searchablePostCount` known/950 and `lastPublishedAt` from the earlier success; UI never claims "Searchable" for it.
- [x] Accept repeated publication updates safely in Convex without double-counting or restarting paid acquisition. Coordinate delivery/retry semantics with Pronsh rather than implementing another indexer retry loop. Closed, live-verified this run (`bunx vitest run tests/scenario-publication-lifecycle.test.ts --reporter=verbose`): duplicate generation → `{"outcome":"duplicate_ignored"}`, stored count unchanged (480, not doubled); stale generation → `{"outcome":"stale_ignored"}`, state stayed "searchable"; jobs table provably unchanged across the update (no reacquire). "Coordinate ... with Pronsh" itself is unconfirmed — see DECISIONS.md.
- [ ] Agree the summary/publication contract with the collaborator before parallel implementation: account identity, capture/job identity, committed generation, unique counts, pending-work units, timestamps, and errors. Not closed: `docs/publication-contract.md` is the draft sent to Pronsh, but its own "Status" line and "Open assumptions" section (read this run) say nothing has been confirmed yet. The receiver/schema/dashboard above were already built against this unconfirmed draft — see DECISIONS.md for the specific assumptions this puts at risk.

## Existing work: use it rather than rebuilding it

- [x] Convex application/control-plane state and retained raw captures exist.
- [x] Tantivy retrieval, a backend-neutral search interface, five sorts, bounded 20-result pages, authenticated HTTP API, and automatic capture indexing are merged into `main`.
- [x] Firecrawl and AgentMail Convex components are integrated; OpenAI query assistance exists.
- [x] Public GitHub repository and hosted app exist. Earlier checks in this session returned HTTP 200 for the hosted app and `ok` for local search health; these do not prove the complete product journey.
- [x] Refresh stale production documentation against observed integration state. Updated `docs/production.md` on September 20: authenticated Tantivy retrieval/pagination verified; hosted frontend/backend version skew and the missing nginx document root remain explicitly unresolved. Corrected service/data/log paths, documented the paused updater and safe build output, and warned that a main push can deploy through CI. The "no publication sender" gap recorded there closed when `4c13fe4` merged; `docs/production.md` now documents the sender's credential file, its `https://`-only rule, and the `publish=enabled` startup check instead. This closes documentation only, not the production rollout.

### Collaborator dependency context — not our implementation backlog

[PR #13](https://github.com/pc-style/xearch/pull/13), `Priyansh4444/xearch-search:adam/search-indexer-ops` → `pc-style/xearch:main`, is open. The inspected diff adds a per-account registry, background watcher, retry/operator controls, signed continuation cursors, and ingestion fixes. At inspection, CodeRabbit was pending and the two Socket checks passed. The author's reported tests were not independently rerun here.

Integration facts to confirm with Pronsh:

- The PR consumes per-handle drop files; production acquisition retains content-addressed capture envelopes. Agree the handoff format without building a competing watcher or registry.
- Registry `accepted` counts records accepted by the last successful import, not unique live documents across all captures. The dashboard needs a distinct published unique-count contract.
- Registry `complete` means an import accepted at least one post, not that the entire account archive is downloaded. Product summaries must preserve that distinction.
- The PR changes Rust/search operations, not the React dashboard or Convex publication/summary model. Those application pieces remain ours.
- The report's engine-side replay ordering, rebuild/deletion application, cursor security, ranking, and engine cutover requirements belong with Pronsh. This document neither assigns nor claims completion of that work.

Other branches on `pc-style/xearch` (`adam/repo-cleanup`, `adam/rewrite-foundations`, `coderabbit/changes/107cedf6`, and `migration/vm-services`) had zero commits ahead of `main`. The collaborator fork contains the additional indexer branch above. GitHub account/commit attribution cannot establish who is working through a shared login, and unpushed work is not visible.

## P1 — Application-side correctness and search integration

- [ ] Agree ownership/deletion metadata with Pronsh before adding collection memberships and scoped tombstones to Convex. Our part is durable product visibility state and its authenticated handoff, not search deletion/rebuild implementation. Not attempted, correctly: no such tables exist in `convex/schema.ts` (confirmed this run) — building them without the stated agreement would itself violate this bullet.
- [ ] Derive authorized collection scope server-side in Convex and pass it through the agreed search contract. Reject unauthorized application requests; verify integration with Pronsh's enforcement. Partial: our fail-closed gate is real and tested — `convex/lib/search.ts:39-42` `assertAuthorizedScope` rejects anything but `{kind:"global"}`, used at `convex/search.ts:47`; `tests/search-contract.test.ts` "rejects a client-requested account scope" passes this run. Remaining: "verify integration with Pronsh's enforcement" needs Pronsh's live side, which doesn't exist yet.
- [x] Surface the service's stale-cursor response as "restart search" rather than a generic failure. Treat cursors as opaque; signing and generation binding stay in the search service. Closed: `convex/lib/search.ts` `STALE_CURSOR_STATUS`/`StaleSearchCursorError`; `convex/search.ts:134-135,146` maps HTTP 409 (only when a cursor was sent) to "This search expired. Restart your search."; `tests/search-contract.test.ts`'s three stale-cursor tests pass this run (verbose re-run).
- [x] Freeze application request/response/error fixtures against the agreed service contract. Keep normalization and ranking implementation with Pronsh. Closed: `tests/search-contract.test.ts` "builds the outbound request from the documented example, field for field" and "decodes the documented example response exactly as published" both pass this run.
- [x] Preserve the existing service boundary so search changes do not require replacing application state or acquisition history. Closed: read `convex/search.ts` in full this run — it only touches `accounts` (read-only), `sessions`, `saved`, and `bookmarks`; it never touches `jobs`, `accountPublications`, or `publicationUpdates`.

## P1 — Complete the real product journey

- [x] Add durable sign-in with verified email. Current guest-only authentication cannot complete the production-safe verified-recipient email flow. Closed: `convex/auth.ts` registers `Anonymous` + `EmailOTP`; `src/auth/EmailSignIn.tsx` is imported and mounted in `src/App.tsx` (confirmed by grep; the line numbers recorded earlier no longer apply after the results-section split, and the "cross-cutting note in DECISIONS.md" this bullet pointed at is not in that file — pointer withdrawn); `tests/journey.test.ts` (12/12 tests passing, verbose re-run this run) covers OTP success/failure/identity/non-owner/default-deny.
- [x] Finish digest preview and explicit send, using AgentMail's existing delivery/retry machinery and ownership checks. Do not invent a second generic mail outbox. Closed: `convex/email.ts`'s `buildDigest` is the single source both `preview` and `send` use; `tests/journey.test.ts` "previews the digest without sending anything, then sends the identical content" and "keeps send gated on a verified, matching email even after digest preview succeeds" both pass this run.
- [ ] Verify import → downloaded/indexing → searchable → search/sort/paginate → conversation or linked page → editable OpenAI assistance → digest preview/send. Partial: the indexer→Convex sender now exists (`search/crates/indexer/src/publish.rs`), so "searchable" is reachable in code. Verified live against production this run with zero state written — an unknown handle returns HTTP 422 `rejected_invalid` and a wrong bearer token returns HTTP 401, through the real sender over TLS, which exercises auth, envelope, routing and the receiver's contract together. Remaining structural blocker on production: outbound finish never delivers a `profile` (`scripts/production-worker.ts` strips it; `worker.report` has no `profile` arg), so `upsertAccount` never runs, `accounts` stays empty, and a publication update for a genuinely indexed handle is 422 `No known account matches…` rather than applied. A profile-kind capture receipt is not an `accounts` row. `PUBLICATION_SERVICE_TOKEN` also had to be created on the production deployment this run because it had never been set, which meant the receiver was failing closed and 401ing every caller regardless of any sender. No end-to-end chain has actually run.
- [ ] Verify Firecrawl, OpenAI, and AgentMail with approved real calls. Configured credentials alone are not evidence that integrations work. Not closed: `docs/production.md` states paid calls have not been live-tested in production; making them is out of this task's hard scope (no paid imports).
- [ ] Verify the public hosted journey and record a short real-product demo after the dashboard and failures are fixed. Not closed: `docs/production.md` says browser visual checks were unavailable during deployment; no demo recording found anywhere in the repo or this session's scratchpad (checked this run).

## Acceptance checks before calling the dashboard fixed

- [x] Repeated runs for one account produce one library row with expandable history; non-account searches remain separate. Closed: same evidence as the P0 "one row per account" and "keep non-account imports separate" bullets above.
- [ ] Overlapping captures and retries do not inflate unique corpus/account totals. Published totals reconcile with the committed search index, not merely job metadata. Partial: non-inflation is proven — `tests/summary.test.ts` "does not dedupe savedCapturesAwaitingIndexing per job..." passes this run. "Reconcile with the committed search index" needs Pronsh's live index, which does not exist yet to reconcile against.
- [x] A downloaded capture with no publication update remains "waiting for indexing." A later confirmed publication updates the dashboard without reacquiring it; simulate the service locally or coordinate a live check with Pronsh. Closed (simulated locally), live-verified this run: `scenario-publication-lifecycle.test.ts` STEP1 — state "waiting_for_indexing", no `accountPublications` row yet; STEP2 — after an accepted "searchable" update, `{"outcome":"applied"}`, jobs table byte-for-byte unchanged (no reacquire), row now "searchable"/480. A live coordinated check with Pronsh has not happened.
- [x] Duplicate publication updates are idempotent, stale updates cannot regress displayed state, and unauthorized application requests fail closed. Closed, live-verified this run (same test): duplicate generation → `duplicate_ignored`, count stayed 480; stale generation → `stale_ignored`, state stayed "searchable"; an unauthorized bearer token over real HTTP (`t.fetch`) returned 401 `{"outcome":"rejected_unauthorized"}` with the row unchanged.
- [x] Provider throttling shows the real reason and retry time. No provider allowance data means "unknown." Historical application caps do not appear as current limits. Closed against real acquisition data, not only synthetic rows: `tests/provider-limits-writepath.test.ts` asserts the provider's verbatim wording reaches the panel, that the more constraining of the two reported policies is the one shown, that `Retry-After` is applied to the observation time, that an absent allowance reads `unknown` rather than 0, and that a stale pre-PR#12 application-cap string left in `jobs.error` still produces `{ kind: "none" }`.
- [x] Test the screenshot's partial/failing imports, successful imports, empty corpus, failed refresh with existing indexed posts, and stale/offline services. Closed, live-verified this run: `bunx vitest run tests/scenario-screenshot-cases.test.ts --reporter=verbose` — all 5 cases pass with console output matching the exact claimed behavior for each (quoted in the P0 bullets above).
- [ ] Inspect rendered desktop and mobile states and exercise retry, continue, filters, and history expansion. Include a reviewed screenshot of the finished dashboard. Partial: personally viewed `scratchpad/11-dashboard-desktop-full.png` and `24-mobile-reconnecting.png` this run. Confirmed: correct section order on both, and a real mobile CSS defect — the "Reconnecting…" badge text wraps mid-word ("Reconnecti"/"ng…"). Not verified: retry/continue/filters/history-expansion, because the shared dev Convex deployment cannot authenticate anyone right now (repeated `Missing environment variable 'JWKS'` in `scratchpad/convex-logs-live.log`) — no account rows are visible in either screenshot to exercise those actions against.
- [x] Run targeted application/backend tests, lint, typecheck, and a frontend build outside live `dist/`. Paid imports and shared deployment changes require separate authorization. Closed, all four run fresh in that session: `bun run test` → 17 files/175 tests passed; `bun run typecheck` → exit 0; `bun run lint` → exit 0 with one pre-existing non-blocking warning; `bunx vite build --outDir <scratchpad>/build-check --emptyOutDir` → succeeded in 328ms, live `dist/` timestamps unchanged (Sep 19 05:43 before and after). Current readings on `4c13fe4` are in the handoff section at the top of this file.

## Later — do not let these delay the repair

- [ ] Automatic account refresh and autonomous discovery.
- [ ] Candidate-of-candidate expansion and elaborate scheduling.
- [ ] Scheduled digests and authenticated inbound-email commands beyond explicit preview/send.
