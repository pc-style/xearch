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
  document (2026-09-20): `convex/jobs.ts`'s `finish` upsert (lines 344-348)
  still resolves accounts purely `by_handle` and unconditionally patches
  whatever row it finds, including a new `userId`. If assumption 1 above turns
  out false (Pronsh's sender can only ever supply a handle), that gap and this
  write-path bug compound each other on a real reassignment. to-do.md tracks
  the write-path fix separately from this contract.
- If any of the five assumptions turn out false, the receiver, the new schema
  tables, and the dashboard queries built against them (`convex/publication.ts`,
  `convex/schema.ts`, `convex/summary.ts`, `convex/library.ts`,
  `convex/limits.ts`) may need to change before a real indexer can use them.
  No real indexer has called `/publication/update` as of this entry.
