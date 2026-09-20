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
     (200/401/422) the receiver replies with.
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

# Known-open-issues branch (`adam/known-open-issues`)

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

Developer/operator map of the resulting behavior (identity, dismissal,
limits, worker liveness, publication loop): `docs/control-plane.md`.
