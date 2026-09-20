# Working in Xearch

User prompts override repository instructions; repository instructions override
global defaults, subject to system and developer requirements.

## Rate limiting

This is early development. Do not add self-imposed rate limits, quotas, or
usage budgets on our own side (per-owner or global counters, daily caps,
"to limit API use" pauses) for imports, search, email, or any other action.
Only respect limits the provider itself reports (e.g. x.md's `retryAfter`) —
we don't control those and shouldn't work around them, but we also should
not add our own on top. If a genuine abuse or cost concern comes up, ask
before adding a budget mechanism back.

## Stack and scope

Use Bun with the committed `bun.lock`. The app uses TypeScript, React 19, Vite,
and hosted Convex. Use Oxlint for linting, Oxfmt for formatting, and Vitest for
tests. `bun run lint` is `oxlint && npx react-doctor@latest` (unpinned). Frontend
async work that raises a busy flag must go through `useTask` / `runTask` in
`src/errors.ts`; do not put `try` / `finally` or `??=` inside a component.
Owner-scoped dashboard queries must pass `"skip"` when signed out (`undefined`
is loading, not signed-out). `convex/summary.ts` `summary`/`health` take a
required client-refreshed `now`; do not call `Date.now()` inside those
queries. See [docs/development.md](docs/development.md). Do not introduce
TypeScript `any` or suppress checks to make code pass unless explicitly
requested. Keep changes scoped; do not add unrequested features or
abstractions.

This repository is the shared application home. Convex owns application state;
Prronsh owns the indexer and Elasticsearch implementation. Preserve the search
service boundary and the Firecrawl, OpenAI, x.md, and AgentMail integrations.
Do not build a competing search implementation without an explicit request.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Production environment

This exe.dev VM is the production machine. Prefer cloud deployments over local
deployments and perform Convex operations against the existing production
deployment, `prod:utmost-kudu-321`, unless the user explicitly requests an
isolated local-development task.

Do not replace the production Convex deployment or change its AgentMail webhook
URL. Do not expose local Convex, databases, development servers, the loopback
capture receiver, or private logs. Production imports can spend provider credits:
never start or test an import without explicit approval, and never start the VM
production worker until the previous worker is confirmed stopped and any final
capture sync is resolved.

Keep the capture receiver on `127.0.0.1:4319`. Use only documented exe.dev
features: https://exe.dev/docs.md and https://exe.dev/docs/proxy.md. Use exe.dev
HTTPS links for user-facing services; this does not authorize exposing private
services or changing access controls. Confirm the domain before configuring
custom public HTTPS. Moving a worker does not move Convex.

Preserve existing `.env*` files, tokens, captures, and database backups. Never
print or commit secrets or private data. Keep service logs private. Read
`docs/production.md` before changing service setup.

## Verification and Git

Inspect actual files and Git state before editing. Preserve unrelated changes.
Use a new branch for migration changes unless the user directs otherwise.
Distinguish committing/pushing, merging, and deploying; do not treat one as
authorization for another.

Run checks proportional to the change: targeted Vitest tests for behavior,
`bun run lint` and `bun run typecheck` for code changes, and a build for frontend
or build-tool changes. Documentation-only edits need a diff/format check, not
the full suite. Do not start development servers or paid imports as routine
verification. Build verification must not overwrite the live frontend's `dist/`;
use a temporary output directory unless deployment is intended.

Report what changed, what was verified, and what remains blocked. When changing
services, distinguish installed, enabled, running, and health-checked state.
