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

Use Bun with the committed `bun.lock`. The app uses TypeScript, SolidJS 2 (pinned release candidate), Vite,
and hosted Convex. Use Oxlint for linting, Oxfmt for formatting, and Vitest for
tests. Do not introduce TypeScript `any` or suppress checks to make code pass
unless explicitly requested. Keep changes scoped; do not add unrequested
features or abstractions.

This repository is the shared application home. Convex owns application state;
Prronsh owns the indexer and Elasticsearch implementation. Preserve the search
service boundary and the Firecrawl, OpenAI, x.md, and AgentMail integrations.
Do not build a competing search implementation without an explicit request.

## PostHog

Production observability belongs to EU PostHog project `283153`. When a change
alters search or result actions, emailed-result success, import/job stages,
Prronsh call outcomes, identity roles, errors, performance, or replayed UI
fields, update the matching instrumentation and PostHog dashboards, alerts, or
scout context in the same work. Keep collection production-only and never send
email addresses.

For frontend releases, verify the published bundle has the production PostHog
key and EU host, upload matching source maps with the private build key, and
confirm live events or errors reach project `283153`. A green deploy check alone
does not prove observability works. Keep self-driving PR creation behind Adam's
approval, with no more than three Xearch self-driving PRs per month across the
old and new PostHog projects.

PostHog access and build configuration:

- The ignored `.env.production.local` holds `VITE_POSTHOG_KEY` and
  `VITE_POSTHOG_HOST` (`https://eu.i.posthog.com`) for VM frontend builds.
- The private `/home/exedev/xearch-data/posthog-build.env` holds
  `POSTHOG_CLI_API_KEY` for source-map uploads. Never print or commit its value.
- GitHub Actions uses repository variables `VITE_POSTHOG_KEY` and
  `VITE_POSTHOG_HOST`, plus the `POSTHOG_CLI_API_KEY` repository secret, for
  production static-hosting deploys.
- Claude Code has a user-scoped PostHog MCP at `https://mcp.posthog.com/mcp`.
  Check it with `claude mcp get posthog`; if disconnected, run
  `claude mcp login --no-browser posthog` and authenticate as the account with
  access to EU project `283153`. Keep OAuth redirect URLs out of Git and chat.

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
