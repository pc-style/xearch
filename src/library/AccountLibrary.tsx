import { createSignal, For, Match, Show, Switch } from "solid-js";
import { useQuery } from "../data/convex";
import { api } from "../../convex/_generated/api";
import type { PublicationState } from "../../convex/lib/contracts";
import { DOWNLOAD_COMPLETE_CAVEAT } from "../jobText";
import AccountRow from "./AccountRow";

// QA finding 5 (/tmp/issues-t3-dashboard-current.md #5): 49 account cards at
// real data volume is a very long unpaginated wall. Slices the already-
// fetched `rows` array client-side — `convex/library.ts rows` returns a
// single bounded (non-cursor-paginated) page already, so there is no server
// pagination to defer to here; see that file's own `truncated` comment.
const PAGE_SIZE = 20;

const STATUS_OPTIONS: { value: PublicationState | ""; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "downloaded", label: "Downloaded" },
  { value: "waiting_for_indexing", label: "Waiting for indexing" },
  { value: "indexing", label: "Indexing" },
  { value: "searchable", label: "Searchable" },
  { value: "failed", label: "Publication failed" },
];

/**
 * The P0 "account library": one primary row per resolved account (never per
 * job), with search and a status filter, and explicit, distinguishable
 * loading / empty / offline / no-match states. Data comes only from
 * `convex/library.ts rows` — no other query.
 */
export default function AccountLibrary(props: {
  isAuthenticated: boolean;
  connected: boolean;
  onConnect: () => void;
}) {
  const [search, setSearch] = createSignal("");
  const [status, setStatus] = createSignal<PublicationState | "">("");
  const [visibleCount, setVisibleCount] = createSignal(PAGE_SIZE);

  const library = useQuery(api.library.rows, () =>
    props.isAuthenticated
      ? { search: search().trim() || undefined, status: status() || undefined }
      : "skip",
  );

  const rows = () => library()?.rows;
  const filtersActive = () => search().trim().length > 0 || status() !== "";

  const hasCompletedRun = () =>
    rows()?.some((row) => row.latestJob?.status === "complete") ?? false;

  return (
    <section id="account-library" class="library-section" aria-label="Account library">
      <div class="library-section-head">
        <h2>Account library</h2>
        <Show when={!props.connected}>
          <p class="library-muted" role="status">
            Reconnecting — showing the last data received, not necessarily current.
          </p>
        </Show>
      </div>
      <div class="library-controls">
        <input
          type="search"
          aria-label="Search accounts"
          placeholder="Search by handle or name"
          value={search()}
          onInput={(e) => {
            setSearch(e.currentTarget.value);
            // A new search narrows which rows exist at all, so the previous
            // "show more" progress no longer means anything.
            setVisibleCount(PAGE_SIZE);
          }}
          disabled={!props.isAuthenticated}
        />
        <select
          aria-label="Filter by publication status"
          onChange={(e) => {
            setStatus(
              // SAFETY: every <option> comes from `STATUS_OPTIONS`, whose
              // values are typed `PublicationState | ""`.
              e.currentTarget.value as PublicationState | "",
            );
            setVisibleCount(PAGE_SIZE);
          }}
          disabled={!props.isAuthenticated}
        >
          <For each={STATUS_OPTIONS}>
            {(o) => (
              <option value={o.value} selected={o.value === status()}>
                {o.label}
              </option>
            )}
          </For>
        </select>
      </div>

      <Switch>
        <Match when={!props.isAuthenticated}>
          <div class="library-empty">
            <p>Connect to see the accounts you've imported.</p>
            <button type="button" onClick={() => props.onConnect()}>
              Connect to my library
            </button>
          </div>
        </Match>
        <Match when={rows() === undefined}>
          <p class="library-loading">Loading your account library…</p>
        </Match>
        <Match when={rows()!.length === 0}>
          <div class="library-empty">
            <Show
              when={filtersActive()}
              fallback={
                <p>
                  No accounts imported yet. Start an "Account history" import to build your library.
                </p>
              }
            >
              <p>No accounts match this search or filter. Try clearing them.</p>
            </Show>
          </div>
        </Match>
        <Match when={true}>
          <div class="library-rows">
            <Show when={library()?.truncated}>
              <p class="library-muted" role="status">
                Showing your most recent accounts. You have more imported than this list can load at
                once, so the figures above report "not yet known" rather than a partial total.
              </p>
            </Show>
            {/* QA finding 5: every completed account used to repeat this exact
                caveat in its own row. It says the same thing regardless of
                which account it's next to, so one section-level note (shown
                only when relevant) replaces all of those. */}
            <Show when={hasCompletedRun()}>
              <p class="library-muted">{DOWNLOAD_COMPLETE_CAVEAT}</p>
            </Show>
            <For each={rows()!.slice(0, visibleCount())} keyed={(row) => row.accountId}>
              {(row) => <AccountRow row={row()} />}
            </For>
            <Show when={rows()!.length > visibleCount()}>
              <button
                type="button"
                class="text-button library-show-more"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              >
                Show more ({rows()!.length - visibleCount()} more)
              </button>
            </Show>
          </div>
        </Match>
      </Switch>
    </section>
  );
}
