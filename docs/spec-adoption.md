# Input from the local-first build specification

The user supplied `xsearch-local-first-build-spec (1).md` on September 19, 2026. This document records the selected ideas and remaining work; it is not acceptance of the entire proposed implementation or benchmark targets.

## Adopted boundaries

- Convex owns application state, ownership, small job summaries, budgets, and integration orchestration. The collaborator owns raw retention, normalization, corpus storage, and retrieval/ranking. No SQLite or Tantivy implementation is added here.
- Ordinary search requests only the collaborator's search endpoint. x.md acquisition, Firecrawl enrichment, and OpenAI interpretation are separate explicit actions, not search prerequisites. No per-hit corpus hydration through Convex.
- JSON history is the default x.md backfill path. Raw envelopes remain intact. Capped unordered NDJSON cannot provide a safe oldest-based continuation; it returns a warning instead. Tests cover both paths, missing completion metadata, and identity changes.
- A raw receipt proves handoff, not searchable publication. Do not display a searchable state without a downstream publication acknowledgment.
- Firecrawl reads linked evidence on demand. Its observed content is not necessarily what existed when the post was written. OpenAI suggestions remain optional and editable. Codex is used for implementation and verification, not added as a fake runtime feature.

## Next joint contract decisions

These need coordination with the collaborator before implementation:

1. Query AST and strict filter semantics, including UTC boundaries, unknown authors, real global Latest ordering, and separately labeled related results. Do not independently duplicate the retrieval analyzer in TypeScript.
2. Search generation/watermark and expiring, query-bound cursors. No exact corpus count is required for ordinary results.
3. Authenticated downstream publication updates, distinct from raw capture receipts. Durable long imports should move to a worker-side job API with bounded Convex reconciliation. Production already runs `COLLECTOR_MODE=outbound` with a VM worker; bulk JSON now requests up to 5,000 posts per page (x.md's documented maximum), splitting oversized pages across captures. A real account has not yet been published end-to-end: outbound finish currently drops `collectXmd`'s profile, so production never inserts an `accounts` row and the receiver rejects updates with `422 rejected_invalid`.
4. Removal propagation and evidence detail retrieval. Separate least-privilege search and capture credentials are implemented through `SEARCH_SERVICE_TOKEN` and `RAW_CAPTURE_TOKEN`, with a legacy shared-token fallback for existing configuration.

## Sponsor work still required for a public launch

- Durable sign-in and verified email recipients; current browser-bound guest sessions are not verified email identities.
- Scheduled saved-search digests using a downstream first-seen/publication watermark. Current AgentMail functionality is explicit sending, not scheduled subscriptions or inbound commands.
- A constrained, authenticated reply flow tied to the owning digest thread. Arbitrary email must never initiate imports, change recipients, or invoke tools.
- Replace retained Convex web previews/search snapshots when the collaborator provides detail endpoints. Web previews are capped at 4,000 characters with their collection time preserved across cache hits. Current bounded one-day caches are a transitional implementation, not a claim of exact compliance with the spec's transient-response design.
- Optional evidence-linked answers only after real retrieval and provenance are connected. No fabricated citations or benchmark claims.

The user's ownership split takes precedence over the attached kickoff prompt: the local ingestion/store/index implementation remains the collaborator's work.
