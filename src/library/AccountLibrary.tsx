import { useState } from "react";
import { useQuery } from "convex/react";
import * as stylex from "@stylexjs/stylex";
import { api } from "../../convex/_generated/api";
import type { PublicationState } from "../../convex/lib/contracts";
import { ops } from "../styles/ops.stylex";
import AccountRow from "./AccountRow";

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
  const library = useQuery(
    api.library.rows,
    isAuthenticated ? { search: search.trim() || undefined, status: status || undefined } : "skip",
  );
  const rows = library?.rows;
  const filtersActive = search.trim().length > 0 || status !== "";

  return (
    <section id="account-library" {...stylex.props(ops.section)} aria-label="Account library">
      <div {...stylex.props(ops.sectionHead)}>
        <h2 {...stylex.props(ops.sectionTitle)}>Account library</h2>
        {!connected && (
          <p {...stylex.props(ops.libraryMuted)} role="status">
            Reconnecting — showing the last data received, not necessarily current.
          </p>
        )}
      </div>
      <div {...stylex.props(ops.controls)}>
        <input
          type="search"
          aria-label="Search accounts"
          placeholder="Search by handle or name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={!isAuthenticated}
          {...stylex.props(ops.controlsField, ops.controlsSearch)}
        />
        <select
          aria-label="Filter by publication status"
          value={status}
          onChange={(e) => setStatus(e.target.value as PublicationState | "")}
          disabled={!isAuthenticated}
          {...stylex.props(ops.controlsField)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {!isAuthenticated ? (
        <div {...stylex.props(ops.emptyBox)}>
          <p>Connect to see the accounts you've imported.</p>
          <button {...stylex.props(ops.button, ops.emptyBoxButton)} onClick={onConnect}>
            Connect to my library
          </button>
        </div>
      ) : rows === undefined ? (
        <p {...stylex.props(ops.loading)}>Loading your account library…</p>
      ) : rows.length === 0 ? (
        <div {...stylex.props(ops.emptyBox)}>
          {filtersActive ? (
            <p>No accounts match this search or filter. Try clearing them.</p>
          ) : (
            <p>
              No accounts imported yet. Start an "Account history" import to build your library.
            </p>
          )}
        </div>
      ) : (
        <div {...stylex.props(ops.rows)}>
          {library?.truncated && (
            <p {...stylex.props(ops.libraryMuted)} role="status">
              Showing your most recent accounts. You have more imported than this list can load at
              once, so the figures above report "not yet known" rather than a partial total.
            </p>
          )}
          {rows.map((row) => (
            <AccountRow key={row.accountId} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}
