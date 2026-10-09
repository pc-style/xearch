/** Types for scripts/lib/rankingCheck.mjs, so tests (and the script) are checked. */

/** One row of a search response, as far as the checks read it. */
export interface Row {
  tweetId: string;
  text: string;
  replyTo?: string;
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  bookmarks?: number;
  media?: object[];
  card?: { title?: string };
  quote?: object;
}

export type Sort = "relevance" | "engagement";

export interface Violation {
  constraint: "says" | "quiet" | "thin" | "phrase";
  row: Row;
  /** For "phrase": the side-by-side match ranked below `row`. */
  below?: Row;
}

export function tokens(text: string): string[];
export function body(row: Row): string;
export function says(row: Row): string[];
export function weighted(row: Row): number;
export function engagement(row: Row): number;
export function thin(row: Row): boolean;
export function sideBySide(row: Row, terms: string[]): boolean;

export const PHRASE_WORTH: Record<Sort, number>;

export function violations(query: string, sort: Sort, rows: Row[]): Violation[];

export interface GroupReport {
  queries: number;
  overlap: number | null;
  medianEngagement: Record<Sort, number | null>;
  [count: string]: number | null | Record<Sort, number | null>;
}

export function report(
  groups: Record<string, string[]>,
  results: Map<string, Row[]>,
): Record<string, GroupReport>;

export const COMMON: string[];

export function sample(
  texts: Iterable<string>,
  options?: { count?: number; seed?: number },
): { common: string[]; words: string[]; phrases: string[] };
