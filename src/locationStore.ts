import type { Accessor } from "solid-js";
import { fromStore } from "./data/external";
import type { Sort } from "../convex/lib/search";
import { ViewMode } from "./uiState";

export interface LocationSnapshot {
  readonly version: number;
  readonly raw: string;
  readonly sort: Sort;
  readonly includeStats: boolean;
  readonly dashboard: boolean;
  /**
   * Operator build only (src/App.tsx inverts its `dashboard` default around
   * this): whether `?search=1` was given to ask for the search view instead
   * of the dashboard the operator build otherwise opens at `/`. Always
   * false in the public build's URLs, where it does nothing.
   */
  readonly search: boolean;
  // `?queue=1`: the old operator Queue page's address, now only read so
  // `opsEntryPatch` can send it to the dashboard's Jobs tab.
  readonly queue: boolean;
  readonly view: ViewMode;
  /** The search app lives at "/" (its views are query params); the
   * operator build's dashboard lives at `OPS_PATH` and its tab paths
   * (`opsTabFromPath`). Anything else is a genuinely unknown address (QA
   * report A14, which found `/nope/does-not-exist` silently rendering the
   * full home page with a 200). */
  readonly path: string;
}

export interface LocationPatch {
  readonly path?: string;
  readonly raw?: string;
  readonly sort?: Sort;
  readonly includeStats?: boolean;
  readonly dashboard?: boolean;
  readonly search?: boolean;
  readonly queue?: boolean;
  readonly view?: ViewMode;
}

const DEFAULT_SORT: Sort = "relevance";

const SORT_VALUES: ReadonlySet<string> = new Set([
  "relevance",
  "engagement",
  "likes",
  "newest",
  "oldest",
]);

const VIEW_VALUES: ReadonlySet<string> = new Set([ViewMode.Search, ViewMode.Bookmarks]);

const SERVER_SNAPSHOT: LocationSnapshot = Object.freeze({
  version: 0,
  raw: "",
  sort: DEFAULT_SORT,
  includeStats: false,
  dashboard: false,
  search: false,
  queue: false,
  view: ViewMode.Search,
  path: "/",
});

const listeners = new Set<() => void>();

let snapshot: LocationSnapshot = SERVER_SNAPSHOT;

let snapshotWindow: Window | null = null;

let snapshotHref: string | null = null;

let listeningWindow: Window | null = null;

let version = SERVER_SNAPSHOT.version;

function browserWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

function isSort(value: string | null): value is Sort {
  return value !== null && SORT_VALUES.has(value);
}

function isView(value: string | null): value is ViewMode {
  return value !== null && VIEW_VALUES.has(value);
}

function parseUrl(input: string | URL): Omit<LocationSnapshot, "version"> {
  const url = input instanceof URL ? input : new URL(input, "https://xearch.invalid");
  const sortValue = url.searchParams.get("sort");
  const viewValue = url.searchParams.get("view");

  return {
    raw: url.searchParams.get("q") ?? "",
    sort: isSort(sortValue) ? sortValue : DEFAULT_SORT,
    includeStats: url.searchParams.get("stats") === "1",
    dashboard: url.searchParams.has("dashboard"),
    search: url.searchParams.has("search"),
    queue: url.searchParams.has("queue"),
    view: isView(viewValue) ? viewValue : ViewMode.Search,
    path: url.pathname,
  };
}

/** Parse a URL into the typed location state used by the application. */
export function parseLocation(input: string | URL): LocationSnapshot {
  return Object.freeze({ version: 0, ...parseUrl(input) });
}

function readBrowserSnapshot(currentWindow: Window, nextVersion: number): LocationSnapshot {
  return Object.freeze({ version: nextVersion, ...parseUrl(currentWindow.location.href) });
}

function currentSnapshot(): LocationSnapshot {
  const currentWindow = browserWindow();

  if (!currentWindow) return SERVER_SNAPSHOT;

  const currentHref = currentWindow.location.href;

  if (snapshotWindow !== currentWindow || snapshotHref !== currentHref) {
    const windowChanged = snapshotWindow !== currentWindow;
    snapshotWindow = currentWindow;
    snapshotHref = currentHref;

    if (!windowChanged) version += 1;
    snapshot = readBrowserSnapshot(currentWindow, version);
  }

  return snapshot;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function publishBrowserLocation(): void {
  const currentWindow = browserWindow();

  if (!currentWindow) return;
  snapshotWindow = currentWindow;
  snapshotHref = currentWindow.location.href;
  version += 1;
  snapshot = readBrowserSnapshot(currentWindow, version);
  notify();
}

function handlePopState(): void {
  publishBrowserLocation();
}

function attachPopState(): void {
  const currentWindow = browserWindow();

  if (!currentWindow || listeningWindow === currentWindow) return;

  if (listeningWindow) listeningWindow.removeEventListener("popstate", handlePopState);
  currentWindow.addEventListener("popstate", handlePopState);
  listeningWindow = currentWindow;
}

function detachPopState(): void {
  if (!listeningWindow) return;
  listeningWindow.removeEventListener("popstate", handlePopState);
  listeningWindow = null;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (listeners.size === 1) attachPopState();

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) detachPopState();
  };
}

export function getSnapshot(): LocationSnapshot {
  return currentSnapshot();
}

export function getServerSnapshot(): LocationSnapshot {
  return SERVER_SNAPSHOT;
}

/**
 * Apply a location patch to a URL and return the resulting query string.
 * Exported so tests can verify how a patch mutates a URL (e.g. that opening
 * the dashboard clears `q=`) without a `window`/`history` — this repo has no
 * jsdom dependency, so `pushLocation`/`replaceLocation` themselves are
 * exercised through the app, not unit tests.
 */
export function previewPatch(input: string | URL, patch: LocationPatch): string {
  const url = input instanceof URL ? new URL(input) : new URL(input, "https://xearch.invalid");
  applyPatch(url, patch);

  return `${url.pathname}${url.search}`;
}

function applyPatch(url: URL, patch: LocationPatch): void {
  if (patch.path !== undefined) url.pathname = patch.path;

  if (patch.raw !== undefined) {
    if (patch.raw) url.searchParams.set("q", patch.raw);
    else url.searchParams.delete("q");
  }

  if (patch.sort !== undefined) url.searchParams.set("sort", patch.sort);

  if (patch.includeStats !== undefined) {
    if (patch.includeStats) url.searchParams.set("stats", "1");
    else url.searchParams.delete("stats");
  }

  if (patch.dashboard !== undefined) {
    if (patch.dashboard) url.searchParams.set("dashboard", "1");
    else url.searchParams.delete("dashboard");
  }

  if (patch.search !== undefined) {
    if (patch.search) url.searchParams.set("search", "1");
    else url.searchParams.delete("search");
  }

  if (patch.queue !== undefined) {
    if (patch.queue) url.searchParams.set("queue", "1");
    else url.searchParams.delete("queue");
  }

  if (patch.view !== undefined) {
    if (patch.view === ViewMode.Search) url.searchParams.delete("view");
    else url.searchParams.set("view", patch.view);
  }
}

function navigate(mode: "pushState" | "replaceState", patch: LocationPatch): void {
  const currentWindow = browserWindow();

  if (!currentWindow) return;

  currentSnapshot();
  const url = new URL(currentWindow.location.href);
  applyPatch(url, patch);
  currentWindow.history[mode](null, "", url);
  publishBrowserLocation();
}

/** The operator dashboard's address. Each tab has its own path below it. */
export const OPS_PATH = "/ops";

/** The dashboard's tabs, in nav order. "overview" lives at `OPS_PATH` itself. */
export const OPS_TABS = [
  "overview",
  "accounts",
  "jobs",
  "imports",
  "performance",
  "provider",
] as const;

export type OpsTab = (typeof OPS_TABS)[number];

const OPS_TAB_SET: ReadonlySet<string> = new Set(OPS_TABS);

function isOpsTab(value: string): value is OpsTab {
  return OPS_TAB_SET.has(value);
}

/** The path for one dashboard tab: `/ops` for the overview, `/ops/<tab>` otherwise. */
export function opsPath(tab: OpsTab): string {
  return tab === "overview" ? OPS_PATH : `${OPS_PATH}/${tab}`;
}

/**
 * Which dashboard tab `path` addresses, or null when it is not a dashboard
 * address at all. `/ops/overview` is not one: the overview's address is
 * `/ops`, so there is exactly one URL per tab. A trailing slash is allowed.
 */
export function opsTabFromPath(path: string): OpsTab | null {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  if (trimmed === OPS_PATH) return "overview";

  if (!trimmed.startsWith(`${OPS_PATH}/`)) return null;
  const tab = trimmed.slice(OPS_PATH.length + 1);

  return tab !== "overview" && isOpsTab(tab) ? tab : null;
}

/**
 * What to do with a page load, or null to leave the URL alone.
 *
 * Operator build: the dashboard lives at `/ops` and `/ops/<tab>`. A bare
 * "/" (no query, no `?search=1`) has always meant the dashboard there, so
 * it becomes `/ops`; the old Queue page link `/?queue=1` becomes
 * `/ops/jobs`. A dashboard address carrying search params (`?q=`,
 * `?search=1`, `?queue=1`) drops them, so the dashboard always opens.
 *
 * Public build: there is no dashboard, so a dashboard address is just the
 * home page at "/" (keeping the rest of the URL). Unknown paths stay as
 * they are and get the not-found page.
 */
export function opsEntryPatch(
  location: Pick<LocationSnapshot, "path" | "raw" | "search" | "queue">,
  operator: boolean,
): LocationPatch | null {
  const tab = opsTabFromPath(location.path);

  if (!operator) return tab ? { path: "/" } : null;

  if (tab)
    return location.raw || location.search || location.queue
      ? { raw: "", search: false, queue: false }
      : null;

  if (location.path === "/" && !location.search && !location.raw)
    return { path: location.queue ? opsPath("jobs") : OPS_PATH, queue: false };

  return null;
}

export function pushLocation(patch: LocationPatch): void {
  navigate("pushState", patch);
}

export function replaceLocation(patch: LocationPatch): void {
  navigate("replaceState", patch);
}

/** Navigate to exactly `href` (path and query), adding a history entry. */
export function pushHref(href: string): void {
  const currentWindow = browserWindow();

  if (!currentWindow) return;

  currentSnapshot();
  currentWindow.history.pushState(null, "", href);
  publishBrowserLocation();
}

export function useLocation(): Accessor<LocationSnapshot> {
  return fromStore(subscribe, getSnapshot);
}
