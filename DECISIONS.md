# Local search implementation

- Requested outcome: reviewed stacked PRs, not merge or production deployment.
- Worktree: `/home/exedev/xearch-search`; base `origin/main`.
- Stack: `adam/search-contracts` -> `adam/search-tantivy` -> `adam/search-api`.
- Tantivy owns postings and retrieval on this VM. Backend-neutral requests, query AST and results allow a later Elasticsearch adapter.
- Keep stop words, lowercase Unicode tokens, no stemming. Quoted phrases require adjacency. No automatic query relaxation.
- Initial validation corpus is the supplied 1,708-post dump. Never check the dump or production secrets into Git.
- Use bounded disk-backed indexing, no corpus-sized resident cache. No paid collection or changes to running production services.
- Done requires behavior, deterministic randomized oracle tests, speed measurements, CLI and HTTP verification, green checks and reviewed current PR heads.
- Private browser integration must preserve Convex ownership and bookmarks; browser result data must be authenticated before persistence.

# Publication contract (built ahead of Pronsh's agreement)

- Requested outcome: an application-side publication receiver and dashboard
  queries so the UI can show real state now, without waiting on a merged
  agreement — not a claim that Pronsh has signed off on the shape below.
  `docs/publication-contract.md` is the draft sent to Pronsh; its own "Status"
  line and "Open assumptions" section say nothing has been confirmed yet, and
  to-do.md's "agree the contract before parallel implementation" item is still
  unchecked.
- Assumptions made without Pronsh's agreement, so a reviewer knows exactly what
  to challenge (verbatim source: `docs/publication-contract.md`'s "Open
  assumptions" section):
  1. **Identity** — the indexer will thread x.md's numeric provider account id
     through to publication updates, even though its own registry (PR #13)
     keys by normalized handle. If false, identity resolution needs rework
     before either side ships against this document.
  2. **Unique count** — the indexer will compute and report a per-account
     deduplicated live-document count (`uniquePostCount`); the registry's
     `accepted`/`rejected` fields today are per-last-import-attempt only, not
     this.
  3. **Delivery direction** — push (indexer calls our `POST
/publication/update`), not Convex polling the indexer.
  4. **State granularity** — handle collisions and index-reset recovery
     surface to us as ordinary `failed`/fresh-`searchable` updates, not a
     distinct event shape.
  5. **`downloaded` vs. `waiting_for_indexing`** — collapsed into one instant
     on our side until the indexer can report a real pickup/start event.

  Also unconfirmed: the auth convention (`PUBLICATION_SERVICE_TOKEN` falling
  back to `DATA_SERVICE_TOKEN`) and the HTTP status mapping
  (200/401/422) the receiver replies with. Assumptions 1-3 are now what the
  in-repo sender actually does (`search/crates/indexer/src/publish.rs`,
  merged in `4c13fe4`); that settles our side of them, not Pronsh's
  agreement.

- Known consequence of building ahead of agreement, found while verifying this
  document (2026-09-20): `convex/jobs.ts`'s `finish` upsert resolved accounts
  purely `by_handle` and unconditionally patched whatever row it found,
  including a new `userId`. If assumption 1 above turns out false (Pronsh's
  sender can only ever supply a handle), that gap and this write-path bug
  compounded each other on a real reassignment.
  **SUPERSEDED** by the account-identity decision in the
  "Known-open-issues branch" section below: the write path now resolves
  `by_user_id` and forks a new row on reassignment, so the compounding risk
  is gone. Assumption 1 itself remains unconfirmed with Pronsh.
- If any of the five assumptions turn out false, the receiver, the new schema
  tables, and the dashboard queries built against them (`convex/publication.ts`,
  `convex/schema.ts`, `convex/summary.ts`, `convex/library.ts`,
  `convex/limits.ts`) may need to change before a real indexer can use them.
  No real indexer has called `/publication/update` as of this entry.

# Known-open-issues branch (`adam/known-open-issues`, merged as `4c13fe4`)

Decisions taken while closing the defects carried in the previous session's
handoff. Each one is a judgement call a reviewer should be able to challenge.

- **Account identity is the provider id, and a reassigned handle forks.**
  `jobs.finish` now resolves `by_user_id` and inserts a new `accounts` row
  when an unknown provider id arrives on a known handle, rather than adopting
  the incumbent row. The consequence is deliberate and worth stating: two
  `accounts` rows can then share one `handle`, so `by_handle` is no longer
  even nominally unique. Every read that used `.unique()` on it
  (`library.ts`, `summary.ts`, `jobs.start`) now reads two and treats an
  ambiguous match as _unresolved_ rather than picking one. The alternative —
  rewriting the previous holder's handle to free it — was rejected: we do not
  know what that account renamed itself to, and inventing a value to preserve
  an index property would be exactly the kind of fabricated data the rest of
  this codebase refuses.
- **Two rows for one provider id patches the first.** Pre-existing duplicates
  created by the old write path are a data problem, not a cross-identity
  merge; both rows already claim the same identity, so no merge risk exists
  and refusing to write would strand the account instead.
- **Dashboard totals are owner-scoped, not global.** `summaryScopeValidator`
  gained an `owner` variant. The numbers are derived from the same
  owner-resolved account set `library.rows` builds from, rather than from a
  new owner column on `accountPublications`, which the handoff had proposed.
  A publication row belongs to an account, not to a person — two owners can
  import the same account — so an owner column there would have had no
  single correct value. Deriving from the caller's own jobs also means the
  tile and the list it links to agree by construction, and retires the old
  unbounded `accountPublications` scan.
- **Dismissal hides, never deletes.** to-do.md forbids deleting records to
  hide duplicates, and there was genuinely no way to clear a finished run.
  `jobs.dismissedAt` hides terminal runs from the feeds and from the
  retryable-work count, and is reversible. It deliberately does NOT reduce
  `savedCapturesAwaitingIndexing`: those captures are still stored and still
  unconfirmed, and hiding a row must not silently retire the evidence under
  it. Active runs cannot be dismissed — hiding work that is still spending
  provider allowance would leave no way to stop it.
- **Live-search input is canonicalised server-side.** `@handle rest`, with a
  lowercased handle. `parseQuery` now also accepts bare `from:handle`, which
  the app's own "find on X" button generates and which the parser previously
  rejected as an unsupported operator. This changes what `jobs.input` holds
  for new live jobs; existing rows keep their old strings and are not
  migrated, so the job feed may show both spellings until old rows age out.
- **Throttle facts are recorded on error responses only.** Successful
  responses carry the same `RateLimit-*` headers, so remaining allowance is
  invisible until something fails. Surfacing it on success needs the client
  to expose headers on the success path too; not done here, and the panel's
  `{ kind: "none" }` therefore still honestly means "nothing observed", never
  "not throttled".
- **`max_posts` raised to the documented 5,000, concurrency left at 8.** The
  provider's live headers (measured, not assumed) put this key at 20 requests
  per 15 minutes, so posts-per-request is the lever that matters and parallel
  chains are not. A live probe at concurrency 8 already showed upstream
  retrying 48 of 62 chains.
- **Oversized pages are split by measured bytes, not by a post count.**
  Retained captures on the VM range from ~2.1 KB to ~6.2 KB per post, so any
  fixed posts-per-capture constant would be wrong at one end of that range.

Decisions added during review of that branch, before it merged:

- **An incomplete ownership scan is refused before its results are looked
  at.** `library.history` first returned whatever the scan found and only
  said "incomplete" when it found nothing. But the scan walks
  `_creationTime` order while history is presented by `updatedAt`, so a run
  the scan never reached can belong in the page it would return. Returning
  the partial set would present a partial scan as the account's history —
  the same failure as presenting a partial count as a total — so
  `exhausted: false` now throws regardless of what was collected.
- **An applied `failed` publication update confirms nothing.**
  `confirmedCaptureIds` counted every `applied` update's `captureIds` as
  confirmed, including ones whose `reportedState` was `"failed"` — so a
  capture the indexer could not index vanished from "saved captures awaiting
  indexing", the one number meant to show outstanding work. `failed` is now
  excluded there. It still moves the account's displayed state; it just does
  not retire the evidence.
- **The sender refuses a cleartext endpoint instead of trusting the
  operator.** Every update carries `PUBLICATION_SERVICE_TOKEN` in an
  `Authorization: Bearer` header, so `PublishConfig::new` rejects any
  `http://` URL whose host is not loopback, at construction, before a
  request can exist. Loopback `http://` stays allowed because that is what
  the crate's own tests point at and those bytes never leave the machine. A
  hostname that merely resolves to loopback is not accepted: DNS is not a
  property this sender can rely on. Failing loudly at startup was chosen
  over failing silently, because a misconfiguration that quietly disabled
  publication looks identical to a working deployment with nothing to say.
- **What a stood-down import would have reported is kept, not dropped.**
  While an update is owed a response its generation is reserved, so a later
  import for the same account cannot publish at it. That import used to just
  log and vanish — and because the importer skips an already-recorded
  capture on every later pass, its capture ids would never have been sent by
  anything, leaving those posts indexed and invisible in the product
  forever. They are now retained on the account
  (`publications.<handle>.deferred`), several stood-down imports coalesce
  into one entry, and the entry goes out as a follow-on update at the next
  generation once the owed update is answered. A follow-on is a new update,
  not a replay: it is recounted and freshly stamped, and only the identity
  comes from the registry.

Developer/operator map of the resulting behavior (identity, dismissal,
limits, worker liveness, publication loop): `docs/control-plane.md`.

# Indexing audit (`adam/indexing-fixes`, 2026-09-24)

Adam's rule: the admin types a handle and xearch indexes every post it can
obtain, on its own. No "next page", "older posts", or "continue" clicks.

- **Import jobs are shared, not personal.** Auth is anonymous-only, and
  `ensureSession` created a new user whenever `isAuthenticated` was false —
  including the moment before the client had verified stored tokens. Prod had
  18 anonymous users for one operator and 49 jobs across 7 owners, so the
  dashboard showed an empty library and "Continuation does not belong to this
  indexing job". Two fixes, both kept: `src/sessionGate.ts` waits for
  `isLoading` before it ever signs in, and jobs/library/summary read across all
  owners because the corpus they describe is already one shared corpus.
  Saved searches, bookmarks, sessions and email deliveries stay per-owner.
- **A provider timeout is a provider error.** `XmdClient` aborts at 120 s; the
  abort escaped as a plain `TimeoutError`, the worker logged "Job interrupted"
  and asked for the same 5000-post page again (huggingface: 7 times). It is now
  `provider_timeout`, retryable, and the collector halves the page to a floor
  of 500. This is not pacing: it asks for less only after the provider failed
  to deliver more.
- **Imports finish on their own.** `finish` continues on `nextCursor` as well
  as `nextUntil`, retries any retryable failure with backoff (up to 10 page
  attempts), and the worker reports generic interruptions as retryable.
  The only manual action left is resuming a run that gave up for good.
- **The operator site tracks main.** It is served from the VM checkout and
  nothing republished it; `scripts/vm-update.sh` now does when application
  code changed. Re-enabling `xearch-update.timer` and restarting the worker
  stay manual, per docs/production.md.

# Later the same day (PRs #44–#52)

- **x.md, not us, is the ceiling for some accounts.** After the timeout and
  page-size changes, huggingface (4th page) and lauren_tan (1st page) still
  failed: x.md answers 504 at its own ~2-minute gateway limit at 8 chains, and
  503 `upstream_rate_limited` at 32. Both ran their 10 automatic attempts and
  stopped with the provider's error. Nothing client-side changes that. A
  failure under the 10-attempt limit is re-queued automatically; a job that
  reaches it is terminal (partial/failed) and a person re-queues it by hand
  once x.md has headroom.
- **Paid actions require an operator; search stays public.** Anyone could
  start x.md imports and Firecrawl/OpenAI calls with an anonymous session.
  `requireOperator` (convex/access.ts) checks the caller's verified email
  against `OPERATOR_EMAILS`; no quota or rate limit was added. Set on prod
  to the operator's address before #50 merged.
- **The operator publish guard follows the dashboard.** The updater refused
  every build after #48 removed the "Dependency health" heading it grepped
  for. The guard and `check-public-bundle.mjs` now share the same marker.
- **One job row, everywhere.** The header modal's "Recent imports" was a
  second job manager with its own bugs (raw URLs, duplicate rows, Retry on
  permanent failures). `src/JobRow.tsx` serves both surfaces; `jobs.retryable`
  is persisted so a permanent provider failure is never offered a retry.
- **Reviews.** CodeRabbit reviews every push; when it reported "rate
  limited" on #41's final head, codex reviewed the diff instead, per the
  house rule.

# PostHog setup (2026-09-24)

- Use EU project 283153 for production search and operator activity. A useful
  search ends when someone opens or bookmarks a result, or AgentMail confirms
  the results email was sent. The funnel starts at form submission.
- Record queries, result URLs, job IDs, stages, provider, duration, status, and
  sanitized errors. Never send email addresses. Identify only non-anonymous
  users by stable ID and role. Replay all sessions while traffic is small;
  show the search field and mask other inputs.
- Two dashboards: "Xearch · Search" (volume, submit-to-useful funnel,
  failure rate, latency, top queries, traffic; the project's landing
  dashboard) and "Xearch · Imports & health" (failures by cause with their
  reasons, throughput, search service success and latency, exceptions).
- One alert path per signal. `job_failed` posts to Discord in real time with
  the sanitised failure reason (the provider's own message when there is
  one; a fixed timeout message when the worker timed out), stage, and cause;
  it fires from every terminal path, including the worker timeout. Error tracking's own issue-created,
  spiking, and reopened destinations cover exceptions. The hourly insight
  alerts that duplicated both were removed (2026-09-24).
- Volume guards: `job_attempt_finished` only reports attempts that errored
  or ended the job (page hops were four fifths of all events); error tracking
  drops more than 300 exceptions per hour project-wide or 30 per issue;
  replay skips sessions under 3 seconds. Performance thresholds wait for a
  production baseline.
- The personal API key for source-map upload is in the private VM file
  `~/xearch-data/posthog-build.env`; both build variants uploaded source maps
  successfully. The frontend and Convex code is prepared but is not published
  by this branch. Native Convex
  exception forwarding requires Convex Pro and has no documented redaction
  hook, so it is not enabled while the no-email-address rule applies.

# Ops dashboard rebuild (`adam/ops-route`, 2026-09-24)

- The operator dashboard is `src/ops`, rendered at `/ops` and `/ops/<tab>`
  (accounts, jobs, imports, performance, provider) as real paths with real
  history entries. In the operator build a bare `/` and the old `?queue=1`
  land on `/ops` and `/ops/jobs`. The public build sends any `/ops` address
  home. The old dashboard (`src/Dashboard.tsx`, `src/library/*` panels, the
  Queue page) is deleted, not kept alongside.
- Every figure comes from a query. Two operator-only reads were added:
  `ops.accounts` (the accounts table with publication, runs, backfill and
  collected range) and `ops.activity` (last 24 h downloads per hour,
  searches, runs by kind, x.md rate-limit responses). Both are bounded and
  say when a bound cut them short.
- What the app does not record is shown as "not tracked yet", never a guess:
  the number of operators, x.md's hourly call budget and calls made, x.md
  latency and cost, the indexer's throughput and backlog history, the oldest
  item waiting. Search latency comes only from searches run with "Stats for
  nerds".
- Actions map to existing mutations only: retry, cancel, dismiss, start
  (refresh, run again, imports). Restart, backfill and "run indexer now"
  have no safe mutation and are left out.
- Queries take the 30-second bucketed clock; ages, stalls and rate-limit
  windows on the page use the exact 5-second clock, because the bucket runs
  up to 30 seconds ahead.

# Dashboard reads by hand (`t3code/manual-refresh-handoff`, 2026-09-25)

- Requested outcome: the operator dashboard makes finite reads on first
  opening each tab and on an explicit Refresh only, with browser-side
  cooldowns and no automatic subscriptions, so an unattended tab costs
  nothing. Incident context: the shell subscribed to every query with a
  30-second clock argument, and the two broadest reads (`ops.activity`,
  `summary.summary`) re-ran twice a minute per open browser plus on every
  worker write. Production is paused; nothing here deploys or resumes it.
- Finite reads go over `ConvexHttpClient` with the session's JWT
  (src/data/httpQuery.ts, `ConvexApp.query`). The WebSocket client keeps
  mutations, auth, and the public page's per-user live queries (search,
  own jobs, saved, bookmarks, email), which stay live on purpose.
- The five heavy queries are renamed and the old names deleted:
  `ops.accountsSnapshot`, `ops.activitySnapshot`, `summary.summarySnapshot`,
  `summary.healthSnapshot`, `queue.timelineSnapshot`. An older dashboard
  build still open gets "could not find public function" with zero reads.
  Hard cut at deploy time (backend from main first, then the operator
  site); no transition stubs. `jobs.list` keeps its name.
- A tab's first open reads only the queries no other tab has already read
  (src/ops/refresh.ts `TAB_QUERIES`). Refresh re-reads the current tab;
  Refresh all re-reads every tab. Per-tab cooldown 30 s, Refresh all
  5 min and it starts every tab's; both start when a read begins,
  including the first open, and persist in `localStorage`
  (`xearch:cooldown:*`) so a reload buys nothing. These frontend cooldowns
  were authorized explicitly, overriding AGENTS.md's no-self-limits rule
  for this feature. No backend budget or limiter.
- Retry, Cancel, Dismiss change the row on screen from what convex/jobs.ts
  wrote; totals wait for Refresh. Bulk dismiss goes one at a time, so a
  failure part-way leaves already-dismissed rows gone and the rest in place.
- Public site: only the ticking or operator-only reads convert
  (`integrations.configured`, the Connections panel's
  `integrations.operator`, the account badge's `auth.me`), all through
  src/data/publicRefresh.ts: a header Refresh button with one shared 30 s
  cooldown that the page load starts. `now` is captured at the read;
  liveness countdowns tick locally against the snapshot.
- PostHog: `ops_dashboard_refresh` {scope initial|tab|all|public, tab,
  queries, durationMs, outcome} and `ops_dashboard_refresh_blocked`
  {scope, tab, remainingMs}. Persisted aggregates
  (`@convex-dev/aggregate`) were considered and rejected for this change.
- Tests prove no read from waiting, hiding/showing, focus, a re-render, or
  returning to a loaded tab (tests/ops-dashboard-ui.test.ts,
  tests/public-refresh-ui.test.ts).
