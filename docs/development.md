# Development

These instructions are for an explicitly isolated local checkout, not the
production VM. For existing services and deployment, see
[production operations](production.md). Never run setup scripts against a
shared deployment as part of routine verification.

## Run locally

```sh
bun install --frozen-lockfile
CONVEX_AGENT_MODE=anonymous bun run backend
```

Leave the backend running. In another terminal, confirm `.env.local` selects
the new anonymous deployment before configuring it. On the first run the
Firecrawl component requires its environment variable to exist. Without a key
yet, set an empty value so other features can run; Firecrawl operations remain
disabled:

```sh
bunx convex env set FIRECRAWL_API_KEY ''
node scripts/setup-auth.mjs --local
bun run dev
```

Run the auth-key script once per new local deployment. It generates backend
signing keys without printing their values. Re-running rotates them and signs
out existing sessions. The frontend is http://localhost:5173. `.env.local` and
`.convex/` are ignored. Use Connections in the app to inspect which integrations
are configured.

Shareable search URLs are `?q=…&sort=relevance|engagement|likes|newest|oldest`.
Add `stats=1` to turn on **Stats for nerds** (the same flag as
`includeStats` on the search request; ordinary results omit timings).
`?dashboard=1` opens the import dashboard. Back/forward restores `q`,
`sort`, and `stats` from `popstate`.

## Local import dashboard

Open `http://localhost:5173/?dashboard=1`. The page is an account library, not
a job wall. `src/Dashboard.tsx` mounts `src/library/Library.tsx` first, then
the non-account job feed, with the import form and Connections in the aside.
Section order matches the compact-layout backlog item:

| Section            | Source                                                             | What it shows                                                           |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Overview           | `convex/summary.ts` `summary` / `health`, `convex/limits.ts` `all` | Indexed posts/people, queue buckets, dependency health, provider limits |
| Account library    | `convex/library.ts` `rows`                                         | One row per resolved account, with search and publication-status filter |
| Active queue       | same `rows`, unfiltered                                            | Currently queued or running bulk jobs                                   |
| Recent run history | same `rows`                                                        | Last few runs across accounts, any outcome                              |
| Other imports      | `convex/jobs.list` minus `kind: "bulk"`                            | Live search, post, profile, followers, following, archive               |
| Start an import    | `convex/jobs.start`                                                | All seven x.md collection tasks                                         |

Only `kind: "bulk"` creates or updates a library row. A live search such as
`from:theo` is not an account identity. Jobs are private to the current guest
session; other tabs in that session update through Convex subscriptions.
Start/stop/retry, continue older pages, and raw-capture receipts stay on the
per-account row (`src/library/AccountRow.tsx`) or on Other imports (`Job`).
The search page's Imports modal is a shortcut job list on `src/App.tsx`; the
account library exists only on this dashboard.

**Indexed people** in Overview is counted from every `accountPublications`
row (global). The list below is owner-scoped to the signed-in caller's own
bulk imports. The tile links to `#account-library` and says so; do not treat
the two numbers as the same set.

Read-side identity in `convex/library.ts` groups by pinned provider account
id (`job.expectedUserId` / `accounts.by_user_id`), falling back to handle
only when no id was pinned. The write path is not there yet:
`convex/jobs.ts` `finish` still looks up `accounts.by_handle` and patches
that row, including a new `userId`. A real handle reassignment can still
overwrite one account's identity with another's. See
[the publication contract](publication-contract.md) and `to-do.md`.

With the local backend running, configure the temporary local receiver once,
then leave it running alongside the backend and frontend:

```sh
bun run capture:setup
bun run capture
```

The setup script is restricted to this anonymous local Convex deployment. It generates a private token and configures the loopback receiver automatically. Captures are saved unchanged under `.local-captures/raw/<sha256>.json`; the token is `.local-captures/token`. Both are ignored by Git. The receiver is loopback-only, checks authorization and checksums, and syncs files before acknowledging them. It is a temporary raw-file sink, not the normalization or search backend, and has no automatic deletion or disk quota. Monitor disk use. It is not suitable for a hosted Convex deployment without replacing the receiver with an authenticated reachable service.

`Downloaded` means raw handoff completed, not confirmed search publication.
New history imports automatically fetch older 500-post batches under one job
and stop if the date boundary fails to move backwards. Only provider-reported
limits should pause acquisition; the application has no daily import budget.
Counts show received posts and may include repeated posts at inclusive page
boundaries. Stop prevents later work and acknowledgments; an already-running
upstream request may still finish and already-written files remain. Technical
details show up to 100 receipts per job. Older completed jobs with more history
offer a continuation button; they are not silently restarted.

Put backend keys and `OPENAI_MODEL` in `.env.local`, then run `bun run env:sync`. The script only syncs allowlisted nonempty variables to the local anonymous deployment and never prints their values. `COLLECTOR_MODE` and `PUBLICATION_SERVICE_TOKEN` are not on that allowlist; set them with `bunx convex env set NAME` when a local publication or outbound-worker check actually needs them. AgentMail webhooks need a public deployment URL; leave the webhook secret unset during local work unless a public callback has separately been configured.

Import controls work without `SEARCH_API_URL`. The separately owned search
service's application boundary is documented in the
[integration contract](integration-contract.md).

### Signed-out vs loading

`useQuery(fn, "skip")` and an in-flight query both return `undefined`. Signed-out
visitors used to sit on "Loading…" forever because owner-scoped queries were
called with `{}` before a session existed. Pass `"skip"` unless
`useConvexAuth().isAuthenticated` is true, then branch the UI on
`isAuthenticated` first:

```ts
const jobs = useQuery(api.jobs.list, isAuthenticated ? {} : "skip");
// signed-out → "Connect to …"; authenticated && jobs === undefined → "Loading…"
```

Current skip sites: `Library` (summary, health, limits, unfiltered rows),
`AccountLibrary` (filtered rows), Dashboard `jobs.list`, and in `src/App.tsx`
results, jobs, saved searches, bookmarks, deliveries, and the email preview.
`Job` receipts skip until the row is expanded, which only happens after
sign-in. Do not "fix" empty signed-out panels by showing a spinner.

`api.integrations.configured` is the exception: it does not call `user(ctx)`,
so Connections can render without a session. It reports **configuration** (env
vars present), not liveness. In `COLLECTOR_MODE=outbound` it also folds in the
desktop collector heartbeat with `Date.now()` inside the query. Convex only
reruns that query when a document or arg changes, so a dead worker can stay
"online" until something else invalidates it. The Overview health panel is
the place that is allowed to talk about liveness, and it uses a different
table (`serviceHealth`) with a client-supplied clock.

### `now` is an argument, not `Date.now()` in the query

`convex/summary.ts` `summary` and `health` take a required `now: number`.
Queries must not read the wall clock; `stale` would freeze at the last
document-driven recompute. `src/library/Library.tsx` passes `now` and
refreshes it every 30 seconds so Overview timestamps and the five-minute
health stale window actually move. Do not restore an optional `now` that
defaults to `Date.now()` in the handler.

Nothing in this tree writes `serviceHealth` or `providerThrottleEvents` yet.
Until a writer exists, health is `"unknown"` / "No health report received
yet", and every provider limit is `{ kind: "none" }` ("No throttling
reported" — not a checked all-clear). `src/integrationStatus.ts` keeps the
two vocabularies apart: `indexingUnavailableMessage` answers "can I start an
import" from `configured`; `serviceHealthLabel` answers "is a dependency
alive" from observed facts. Do not merge them.

`src/library/summaryApi.tsx` and `src/library/limitsApi.tsx` still call
`summary` / `health` / `limits.all` through `anyApi` aliases. Codegen now
lists those modules in `convex/_generated/api.d.ts`; the aliases resolve to
the same functions. Prefer `api.summary.*` / `api.limits.all` in new code.

## Connect providers

Use `bunx convex env set NAME` and supply the value through stdin/the prompt. Do not use `VITE_` variables for secrets.

| Variable                    | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `X_MD_API_KEY`              | x.md acquisition credential                                                   |
| `X_MD_BASE_URL`             | Optional alternate official origin, `https://x.pcstyle.dev`                   |
| `RAW_CAPTURE_URL`           | Durable raw-capture receiver                                                  |
| `SEARCH_API_URL`            | Search service retrieval endpoint                                             |
| `SEARCH_SERVICE_TOKEN`      | Read-only credential for the search endpoint                                  |
| `RAW_CAPTURE_TOKEN`         | Ingestion-only credential for the capture receiver                            |
| `DATA_SERVICE_TOKEN`        | Legacy shared fallback when a dedicated token is unset                        |
| `FIRECRAWL_API_KEY`         | Linked-page scraping and web-context search                                   |
| `OPENAI_API_KEY`            | Editable query interpretation                                                 |
| `OPENAI_MODEL`              | Optional model override; default `gpt-5-mini`                                 |
| `AGENTMAIL_API_KEY`         | Result-digest delivery                                                        |
| `AGENTMAIL_INBOX_ID`        | Existing sender inbox                                                         |
| `AGENTMAIL_WEBHOOK_SECRET`  | Verification of delivery webhooks                                             |
| `COLLECTOR_MODE`            | `outbound` uses the production worker heartbeat; unset uses `RAW_CAPTURE_URL` |
| `PUBLICATION_SERVICE_TOKEN` | Auth for `POST /publication/update`; falls back to `DATA_SERVICE_TOKEN`       |

Register AgentMail's webhook at `<deployment>.convex.site/agentmail/webhook` for delivery events. A send is queued only by the explicit Email → Send results action. The interface distinguishes queued/sent/delivered states.

The UI exposes account imports, search, and conversation collection. The same `jobs.start` API accepts `profile`, `following`, `followers`, and `archive`; these preserve complete responses for downstream account-discovery work. `bulk` supports `refresh:true` for engagement updates. All collection paths require a configured receiver, so an import never claims success by merely fetching data.

## Verify

```sh
bun run lint
bun run typecheck
bun run test
bunx vite build --outDir "$(mktemp -d /tmp/xearch-build.XXXXXX)"
```

Build verification uses a temporary directory so it cannot overwrite the live VM frontend in `dist/`.

`bun run lint` is `oxlint && npx react-doctor@latest`. Oxlint uses the Effect
presets; `prepare` patches Oxlint and tsgolint on install. React Doctor is
unpinned (`@latest`), so a new release can fail Check without any commit.
Vite compiles the UI with the React Compiler (`vite.config.ts`, target 19).
The Check workflow (`.github/workflows/ci.yml`) runs that lint script and
fails on errors. `.github/workflows/react-doctor.yml` is a separate advisory
scan: it comments on PRs and does not fail the job.

Search-service responses are decoded with Effect Schema in
`convex/lib/results.ts`; other validators still use Zod.

Tests cover raw payload preservation, JSON backfill pagination, safe unordered-stream behavior, stream completion, partial capture, identity pinning, origin selection, retry timing, durable receipts, user isolation, and the Firecrawl component response shape. Provider calls are mocked in tests. No email is sent and no provider credits are consumed by the suite. Selected ideas and remaining work from the supplied local-first spec are tracked in [spec adoption](spec-adoption.md).

## Async UI work

Async buttons and forms that raise a busy flag share one helper:
`useTask` / `runTask` in `src/errors.ts`. One `useTask()` call is one busy
flag and one message slot. `run` clears the message, sets busy, then on the
way out shows an optional success string or `describeError`'s text, and
always lowers busy — including when the work throws.

```ts
const { busy, message, setMessage, run } = useTask();

void run(async () => {
  await ensureSession();
  await start({ kind, input });
}, "Import started. You can leave this page open or come back later.");
```

Rename on destructuring when the screen already has its own words
(`busy: pending`, `message: error`, `run: task` / `act`). Current owners:

| Component                    | Hook                | Work it drives                                                                                              |
| ---------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                | `useTask` as `task` | search start, import, live lookup, read-link, interpret, web context, bookmarks, saved searches, email send |
| `src/Dashboard.tsx`          | `useTask` as `run`  | the import form                                                                                             |
| `src/library/AccountRow.tsx` | `useTask` as `act`  | retry, continue, stop                                                                                       |
| `src/auth/EmailSignIn.tsx`   | `useTask` as `run`  | request code, verify code                                                                                   |

`App` shares one slot across all of those actions, so a search spinner and an
import notice are the same pair of states. That was true before the helper
was extracted; do not split it unless the UI is meant to show two independent
pending flags.

### Why the helper is imported, not inlined

The React Compiler cannot lower a `try` with a `finally` inside a component
or hook body (`Handle TryStatement with a finalizer`). The call sites then
fail react-doctor's impure-updater rule, because a function that mentions a
`useState` setter counts as a state updater with side effects. `runTask` is
a plain module-level function the compiler never analyses. `useTask` is the
imported hook that owns the two pieces of state.

A thin local wrapper would still fail. This is flagged the same way as the
old in-component `task` / `act` helpers:

```ts
// Still an impure updater: the local function closes over setBusy.
const task = (fn: () => Promise<unknown>) => runTask(fn, { setBusy, setMessage });
```

Reach the runner through the imported hook (or call `runTask` directly with
explicit setters). Do not retype `try` / `catch` / `finally` around mutations
inside a component.

### Stale searches and `ensureSession`

The search effect in `src/App.tsx` cannot use `task()` as-is: a superseded
request must not clear a newer spinner. It calls `runTask` with setters that
go quiet after cleanup:

```ts
let active = true;
await runTask(fn, {
  setBusy: (value) => {
    if (active) setBusy(value);
  },
  setMessage: (value) => {
    if (active) setNotice(value);
  },
});
return () => {
  active = false;
};
```

`ensureSession` in the same file assigns the in-flight anonymous sign-in with
`if (session.current === null)`, not `session.current ??= …`. The compiler
cannot lower `??=` either, and the error text looks the same as the
try/finally failure.

### When not to use `useTask`

`Dashboard.tsx`'s `Job` rows still use a local `try` / `catch` with no
`finally`. They have no busy flag — only an error string — so the compiler
rule does not apply. The dashboard "Connect to my jobs" button is the same
shape around `ensureSession`. Do not "upgrade" those to `useTask` just for
uniformity.

A form's actual submit control needs `type="submit"` (search, the import
forms in `App` and `Dashboard`, email sign-in, send-results). Non-submit
controls in those forms use `type="button"`. Do not blanket-apply one type.

## Guest sessions and publication

Guest sessions let users use the app without an invite. Saved state belongs to
that browser session; clearing its credentials loses access. Guest sessions are
not verified email identities. Durable email sign-in exists (`convex/auth.ts`'s
Email OTP provider, delivered through AgentMail) and gates sending a digest to a
verified, matching address (`convex/email.ts` `send`); an anonymous guest session
can search and import but can never pass that gate. The publication receiver and
dashboard queries also exist (`convex/publication.ts`, `convex/summary.ts`,
`convex/library.ts`, `convex/limits.ts` — see
[the publication contract](publication-contract.md)). None of this has been
exercised against a real AgentMail send or a real indexer yet — only against
mocks and a local convex-test deployment — which [the application
backlog](../to-do.md) still tracks as open verification work. Raw acquisition
receipts do not confirm downstream indexing. Search pages are short-lived UI
snapshots, not a local corpus. Pronsh owns the corpus and search implementation.
