/** Types for scripts/lib/discovery.mjs, so tests (and the script) are checked. */
export interface DiscoveryPost {
  author?: { screen_name?: string };
  replying_to?: { screen_name?: string }[];
  quote?: { author?: { screen_name?: string } };
  raw_text?: { facets?: { type?: string; original?: string }[] };
  reposted_by?: { screen_name?: string }[];
}

export interface DiscoveredAccount {
  handle: string;
  interactions: number;
  discoveredFrom: { handle: string; interactions: number }[];
}

/** Anything a capture may hold where a handle is expected. */
export type HandleLike = string | number | boolean | null | undefined;

export function normalizeHandle(value: HandleLike): string | null;
export function interactionsOf(post: DiscoveryPost): Set<string>;
export function rankInteractions(
  posts: DiscoveryPost[],
  options: { indexed: Iterable<string>; exclude: Iterable<string>; minInteractions: number },
): DiscoveredAccount[];

/** One retained capture file as written by scripts/capture-server.mjs. */
export interface RawCapture {
  records?: { payload?: { posts?: DiscoveryPost[]; post?: DiscoveryPost } }[];
}

export function postsInCapture(capture: RawCapture): DiscoveryPost[];
