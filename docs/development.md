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

## Local import dashboard

Open `http://localhost:5173/?dashboard=1` for the live import controls. Start/stop/retry jobs, continue older pages, and inspect raw-capture receipts. All seven x.md collection tasks are available. Jobs are private to the current guest session; other tabs in that session update through Convex subscriptions.

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

Put backend keys and `OPENAI_MODEL` in `.env.local`, then run `bun run env:sync`. The script only syncs allowlisted nonempty variables to the local anonymous deployment and never prints their values. AgentMail webhooks need a public deployment URL; leave the webhook secret unset during local work unless a public callback has separately been configured.

Import controls work without `SEARCH_API_URL`. The separately owned search
service's application boundary is documented in the
[integration contract](integration-contract.md).

## Connect providers

Use `bunx convex env set NAME` and supply the value through stdin/the prompt. Do not use `VITE_` variables for secrets.

| Variable                   | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `X_MD_API_KEY`             | x.md acquisition credential                                 |
| `X_MD_BASE_URL`            | Optional alternate official origin, `https://x.pcstyle.dev` |
| `RAW_CAPTURE_URL`          | Durable raw-capture receiver                                |
| `SEARCH_API_URL`           | Search service retrieval endpoint                           |
| `SEARCH_SERVICE_TOKEN`     | Read-only credential for the search endpoint                |
| `RAW_CAPTURE_TOKEN`        | Ingestion-only credential for the capture receiver          |
| `DATA_SERVICE_TOKEN`       | Legacy shared fallback when a dedicated token is unset      |
| `FIRECRAWL_API_KEY`        | Linked-page scraping and web-context search                 |
| `OPENAI_API_KEY`           | Editable query interpretation                               |
| `OPENAI_MODEL`             | Optional model override; default `gpt-5-mini`               |
| `AGENTMAIL_API_KEY`        | Result-digest delivery                                      |
| `AGENTMAIL_INBOX_ID`       | Existing sender inbox                                       |
| `AGENTMAIL_WEBHOOK_SECRET` | Verification of delivery webhooks                           |

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

| Command                | What it runs                           | Used by Check?                              |
| ---------------------- | -------------------------------------- | ------------------------------------------- |
| `bun run lint`         | Oxlint, then `npx react-doctor@latest` | Yes — this is the Check step                |
| `bun run react-doctor` | The same unpinned scan, alone          | No — Check still runs Oxlint first          |
| `bun run doctor`       | `react-compiler-healthcheck`           | No — compiler coverage, not Check errors    |
| `bun run lint:fix`     | `oxlint --fix`                         | No — does not rewrite react-doctor findings |

If Check is red on `Handle TryStatement with a finalizer` or an impure
updater, run `bun run lint`, not `bun run doctor`. See
[Async UI work](#async-ui-work) for the helper that keeps those errors gone.

Search-service responses are decoded with Effect Schema in
`convex/lib/results.ts`; other validators still use Zod.

Tests cover raw payload preservation, JSON backfill pagination, safe unordered-stream behavior, stream completion, partial capture, identity pinning, origin selection, retry timing, durable receipts, user isolation, and the Firecrawl component response shape. Provider calls are mocked in tests. No email is sent and no provider credits are consumed by the suite. Selected ideas and remaining work from the supplied local-first spec are tracked in [spec adoption](spec-adoption.md).

## Async UI work

Async buttons and forms that raise a busy flag share one helper:
`useTask` / `runTask` in `src/errors.ts`. One `useTask()` call is one busy
flag and one message slot. `run` clears the message, sets busy, then on the
way out shows an optional success string or `describeError`'s text, and
always lowers busy — including when the work throws. Failures are not
rethrown; `void run(...)` is the intended call shape. `tests/errors.test.ts`
covers `describeError`'s Convex wrapper stripping, not the busy-flag helper.

```ts
const { busy, message, setMessage, run } = useTask();

void run(async () => {
  await ensureSession();
  await start({ kind, input });
}, "Import started. You can leave this page open or come back later.");
```

Use `setMessage` for checks that never start the work — invalid email or an
empty code in `src/auth/EmailSignIn.tsx` set the error and return before
`run`. Those paths must not raise busy.

Rename on destructuring when the screen already has its own words
(`busy: pending`, `message: error`, `run: task` / `act`). Current owners:

| Component                    | Hook                | Work it drives                                                                                              |
| ---------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                | `useTask` as `task` | search start, import, live lookup, read-link, interpret, web context, bookmarks, saved searches, email send |
| `src/Dashboard.tsx`          | `useTask` as `run`  | the import form; Connect to my jobs writes the same `setMessage`                                            |
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

`try` / `catch` without `finally` is allowed: `App.tsx` uses it while parsing
the live query, and `Dashboard.tsx`'s `Job` helper uses it around retry /
stop / continue. Promise `.finally()` is also allowed —
`ensureSession` clears its in-flight promise that way. The compiler error
names a `TryStatement` with a finalizer, not `Promise.prototype.finally`.

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

After `signIn("anonymous")` it still waits for the Convex websocket to
confirm authentication, up to 20 seconds. The user-facing text for that
deadline is `Session connection timed out. Try again.` Concurrent callers
share one in-flight promise; `.finally()` clears it so the next click can
start a new attempt.

### When not to use `useTask`

`Dashboard.tsx`'s `Job` rows still use a local `try` / `catch` with no
`finally`. They have no busy flag — only an error string — so the compiler
rule does not apply. Do not "upgrade" those to `useTask` just for
uniformity.

The dashboard "Connect to my jobs" button is the same try/catch shape around
`ensureSession`, but its `catch` writes `"Could not start your session."`
through the import form's `setMessage`. One `useTask()` in `Dashboard`
backs both the form and that button; a connect failure shows on the form's
status line.

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
