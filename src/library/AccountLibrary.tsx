import { useState } from "react";
import { useQuery } from "convex/react";
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
export default function AccountLibrary({
  isAuthenticated,
  connected,
  onConnect,
}: {
  isAuthenticated: boolean;
  connected: boolean;
  onConnect: () => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PublicationState | "">("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const library = useQuery(
    api.library.rows,
    isAuthenticated ? { search: search.trim() || undefined, status: status || undefined } : "skip",
  );

  const rows = library?.rows;
  const filtersActive = search.trim().length > 0 || status !== "";
  const visibleRows = rows?.slice(0, visibleCount);
  const hasCompletedRun = rows?.some((row) => row.latestJob?.status === "complete") ?? false;

  return (
    <section id="account-library" className="library-section" aria-label="Account library">
      <div className="library-section-head">
        <h2>Account library</h2>
        {!connected && (
          <p className="library-muted" role="status">
            Reconnecting — showing the last data received, not necessarily current.
          </p>
        )}
      </div>
      <div className="library-controls">
        <input
          type="search"
          aria-label="Search accounts"
          placeholder="Search by handle or name"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            // A new search narrows which rows exist at all, so the previous
            // "show more" progress no longer means anything — reset to the
            // first page instead of a filtered list opening already-expanded
            // past its own row count.
            setVisibleCount(PAGE_SIZE);
          }}
          disabled={!isAuthenticated}
        />
        <select
          aria-label="Filter by publication status"
          value={status}
          onChange={(e) => {
            setStatus(
              // SAFETY: every <option> below comes from `STATUS_OPTIONS`, whose
              // `value`s are typed `PublicationState | ""`, so the <select>'s
              // string value is always one of them.
              e.target.value as PublicationState | "",
            );
            setVisibleCount(PAGE_SIZE);
          }}
          disabled={!isAuthenticated}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {!isAuthenticated ? (
        <div className="library-empty">
          <p>Connect to see the accounts you've imported.</p>
          <button onClick={onConnect}>Connect to my library</button>
        </div>
      ) : rows === undefined ? (
        <p className="library-loading">Loading your account library…</p>
      ) : rows.length === 0 ? (
        <div className="library-empty">
          {filtersActive ? (
            <p>No accounts match this search or filter. Try clearing them.</p>
          ) : (
            <p>
              No accounts imported yet. Start an "Account history" import to build your library.
            </p>
          )}
        </div>
      ) : (
        <div className="library-rows">
          {library?.truncated && (
            <p className="library-muted" role="status">
              Showing your most recent accounts. You have more imported than this list can load at
              once, so the figures above report "not yet known" rather than a partial total.
            </p>
          )}
          {/* QA finding 5: every completed account used to repeat this exact
              caveat in its own row — once per row, 49 times at real data
              volume. It says the same thing regardless of which account it's
              next to, so one section-level note above the list (shown only
              when it's actually relevant to something in the list) replaces
              all of those without losing the information. */}
          {hasCompletedRun && <p className="library-muted">{DOWNLOAD_COMPLETE_CAVEAT}</p>}
          {(visibleRows ?? rows).map((row) => (
            <AccountRow key={row.accountId} row={row} />
          ))}
          {rows.length > visibleCount && (
            <button
              type="button"
              className="text-button library-show-more"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              Show more ({rows.length - visibleCount} more)
            </button>
          )}
        </div>
      )}
    </section>
  );
}
