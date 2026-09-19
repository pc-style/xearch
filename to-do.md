# Xearch to-do

Updated September 19, 2026. Planning only: this list does not authorize implementation, paid imports, merging, or deployment.

Ownership: Pronsh owns search and indexing. Our backlog covers the application, acquisition, Convex integration, and UI. Do not assign search-engine, ranking, replay, indexer, or cursor implementation to our agents. Mention collaborator work only as dependency context, not as our tasks.

## Priority: make the existing product understandable and reliable

Fix the import/library dashboard and its underlying data before adding discovery or more features. The current screen is a job log: repeated accounts, stale phases, contradictory search messages, and no useful corpus overview. Do not mistake duplicate job rows for proof of duplicate indexed posts; measure both separately.

### P0 — Replace the job wall with an account library

- [ ] Show one primary row per account, with display name/handle, unique indexed-post count, current download/indexing state, last successful publication, and a relevant next action.
- [ ] Group retries, batches, and older runs under expandable account history. Preserve receipts and failure evidence; do not delete records just to hide duplicates.
- [ ] Group by stable provider account ID where known, using normalized handles only as a fallback. Do not combine different identities after a handle reassignment.
- [ ] Keep live-search requests, conversations, and other non-account imports separate from the indexed-people list. A search input such as `from:theo` is not an account identity.
- [ ] Show indexed accounts even when their latest refresh failed. Keep the usable corpus visible alongside the latest error.
- [ ] Replace the oversized repeated cards with a compact, readable layout: overview, account library, active queue, and secondary run history. Keep importing easy to find without letting the form dominate the page.
- [ ] Provide account search and useful status filters. Make loading, empty, offline, stale-data, and partial-failure states explicit.
- [ ] Remove contradictory copy such as “downloads aren't searchable yet” and “search will be available when connected” when indexed data is actually available. Configuration, connectivity, download completion, and search publication are different states.
- [ ] Do not leave failed jobs showing only “Saving raw capture.” Show the current failure, retained progress, and the next useful action; keep raw diagnostics in details.

### P0 — Show simple, trustworthy stats

- [ ] **Indexed posts:** unique, currently searchable post IDs from the committed index, not summed download counts or accepted-record receipts. State the authorized scope and observation time.
- [ ] **Indexed people:** distinct accounts with searchable posts; link the number to the account list.
- [ ] **Queue:** distinguish waiting downloads, active downloads, saved captures awaiting indexing, and failed/retryable work. Label units explicitly: jobs, captures, or posts.
- [ ] Show queued-post counts only when known. Unknown provider history size is “unknown,” not zero or an invented estimate. Do not label a count of files as a count of posts.
- [ ] **Provider limits:** show provider-reported throttling, remaining allowance/reset when actually supplied, the affected operation, and the next retry time. If remaining allowance is unavailable, say so.
- [ ] Respect provider `Retry-After`/`retryAfter`. Do not reintroduce application daily caps, quotas, or usage budgets; their removal is already merged in PR #12.
- [ ] Separate current provider throttling from historical “today's import limit” errors left on old jobs. Do not present an old error as the current account limit.
- [ ] Expose safe summary data through authenticated backend contracts. Do not expose raw state files, service credentials, private logs, or another user's data to the browser.
- [ ] Report worker/indexer health and last successful activity separately from “configured.” Stale or unavailable stats must not look like live zeroes.

### P0 — Fix import failures and connect publication state

- [ ] Investigate the screenshot's “x.md history is missing posts, profile, or its completion summary” failures against retained captures and the actual parser contract. Capture the failing response shape in a sanitized fixture before changing validation.
- [ ] Determine why runs can retain 500 posts and then stop. Preserve saved data, distinguish valid partial history from malformed input, and do not weaken completeness checks just to make jobs green.
- [ ] Make retry/continue reuse durable progress where possible without creating another top-level account row or duplicating indexed posts. Prevent accidental duplicate active acquisition for the same scope without blocking intentional refreshes.
- [ ] Implement the Convex receiver for authenticated, idempotent publication updates supplied by Pronsh's service. Raw capture receipt means downloaded; only confirmed index publication means searchable. The indexer-side sender is Pronsh's work.
- [ ] Represent downloaded, waiting for indexing, indexing, searchable, and failed publication separately. A failed refresh must not erase the previous searchable state.
- [ ] Accept repeated publication updates safely in Convex without double-counting or restarting paid acquisition. Coordinate delivery/retry semantics with Pronsh rather than implementing another indexer retry loop.
- [ ] Agree the summary/publication contract with the collaborator before parallel implementation: account identity, capture/job identity, committed generation, unique counts, pending-work units, timestamps, and errors.

## Existing work: use it rather than rebuilding it

- [x] Convex application/control-plane state and retained raw captures exist.
- [x] Tantivy retrieval, a backend-neutral search interface, five sorts, bounded 20-result pages, authenticated HTTP API, and automatic capture indexing are merged into `main`.
- [x] Firecrawl and AgentMail Convex components are integrated; OpenAI query assistance exists.
- [x] Public GitHub repository and hosted app exist. Earlier checks in this session returned HTTP 200 for the hosted app and `ok` for local search health; these do not prove the complete product journey.
- [ ] Refresh stale production documentation after the actual integration is verified; it still says search is disconnected.

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

- [ ] Agree ownership/deletion metadata with Pronsh before adding collection memberships and scoped tombstones to Convex. Our part is durable product visibility state and its authenticated handoff, not search deletion/rebuild implementation.
- [ ] Derive authorized collection scope server-side in Convex and pass it through the agreed search contract. Reject unauthorized application requests; verify integration with Pronsh's enforcement.
- [ ] Surface the service's stale-cursor response as “restart search” rather than a generic failure. Treat cursors as opaque; signing and generation binding stay in the search service.
- [ ] Freeze application request/response/error fixtures against the agreed service contract. Keep normalization and ranking implementation with Pronsh.
- [ ] Preserve the existing service boundary so search changes do not require replacing application state or acquisition history.

## P1 — Complete the real product journey

- [ ] Add durable sign-in with verified email. Current guest-only authentication cannot complete the production-safe verified-recipient email flow.
- [ ] Finish digest preview and explicit send, using AgentMail's existing delivery/retry machinery and ownership checks. Do not invent a second generic mail outbox.
- [ ] Verify import → downloaded/indexing → searchable → search/sort/paginate → conversation or linked page → editable OpenAI assistance → digest preview/send.
- [ ] Verify Firecrawl, OpenAI, and AgentMail with approved real calls. Configured credentials alone are not evidence that integrations work.
- [ ] Verify the public hosted journey and record a short real-product demo after the dashboard and failures are fixed.

## Acceptance checks before calling the dashboard fixed

- [ ] Repeated runs for one account produce one library row with expandable history; non-account searches remain separate.
- [ ] Overlapping captures and retries do not inflate unique corpus/account totals. Published totals reconcile with the committed search index, not merely job metadata.
- [ ] A downloaded capture with no publication update remains “waiting for indexing.” A later confirmed publication updates the dashboard without reacquiring it; simulate the service locally or coordinate a live check with Pronsh.
- [ ] Duplicate publication updates are idempotent, stale updates cannot regress displayed state, and unauthorized application requests fail closed.
- [ ] Provider throttling shows the real reason and retry time. No provider allowance data means “unknown.” Historical application caps do not appear as current limits.
- [ ] Test the screenshot's partial/failing imports, successful imports, empty corpus, failed refresh with existing indexed posts, and stale/offline services.
- [ ] Inspect rendered desktop and mobile states and exercise retry, continue, filters, and history expansion. Include a reviewed screenshot of the finished dashboard.
- [ ] Run targeted application/backend tests, lint, typecheck, and a frontend build outside live `dist/`. Paid imports and shared deployment changes require separate authorization.

## Later — do not let these delay the repair

- [ ] Automatic account refresh and autonomous discovery.
- [ ] Candidate-of-candidate expansion and elaborate scheduling.
- [ ] Scheduled digests and authenticated inbound-email commands beyond explicit preview/send.
