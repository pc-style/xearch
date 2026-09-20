import {
  XmdClient,
  ProviderError,
  record,
  string,
  MAX_POSTS_PER_PAGE,
  type RawObject,
} from "./xmd";
import type { Capture, Receipt } from "./handoff";

/**
 * Bytes of provider payload allowed in one capture. `deliverCapture` rejects a
 * capture body over 4,000,000 bytes outright (`capture_too_large`), so this
 * leaves ~1 MB for the capture envelope, per-record metadata, and any UTF-8
 * accounting drift. It is a transport budget, not a usage budget: it never
 * slows, paces, or caps what we ask the provider for.
 */
const CAPTURE_BUDGET = 3_000_000;
/** Per-record allowance for the `part` metadata and record framing. */
const RECORD_OVERHEAD = 256;
/** Ordinary stream records per capture (docs/integration-contract.md). */
const RECORDS_PER_CAPTURE = 25;
const measure = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/**
 * Split one oversized history page into envelope-shaped parts that each fit in
 * a capture. Every part repeats the page's own envelope (profile, meta, and any
 * unknown fields) verbatim and carries a disjoint, in-order slice of `posts`,
 * so concatenating the slices reproduces the provider's page exactly. Slicing
 * is driven by measured serialized bytes, never an assumed posts-per-capture
 * count: real captures on this machine range from ~2.1 KB to ~6.2 KB per post.
 */
export function splitHistoryPage(envelope: RawObject, budget = CAPTURE_BUDGET): RawObject[] {
  const posts = envelope.posts;
  if (!Array.isArray(posts) || posts.length < 2 || measure(envelope) <= budget) return [envelope];
  // `{...envelope, posts: []}` keeps the provider's key order, so this is the
  // exact fixed cost every part pays before its own posts are added.
  const overhead = measure({ ...envelope, posts: [] }) + RECORD_OVERHEAD;
  const slices: unknown[][] = [];
  let slice: unknown[] = [];
  let size = overhead;
  for (const post of posts) {
    const cost = measure(post) + 1; // the separating comma
    if (slice.length && size + cost > budget) {
      slices.push(slice);
      slice = [];
      size = overhead;
    }
    slice.push(post);
    size += cost;
  }
  if (slice.length) slices.push(slice);
  return slices.map((posts) => ({ ...envelope, posts }));
}

export type CollectionRequest = {
  runId: string;
  attempt: number;
  kind: "bulk" | "live" | "post" | "profile" | "following" | "followers" | "archive";
  input: string;
  since?: string;
  until?: string;
  cursor?: string;
  refresh?: boolean;
  expectedUserId?: string;
  /** NDJSON is for bounded streaming, never oldest-based backfill pagination. */
  format?: "json" | "ndjson";
};
export async function collectXmd(
  client: XmdClient,
  request: CollectionRequest,
  sink: (capture: Capture) => Promise<Receipt>,
  onReceipt: (receipt: Receipt, count: number) => Promise<void>,
  now = Date.now,
  onIdentity?: (id: string) => Promise<void>,
  onStage?: (phase: string) => Promise<void>,
) {
  let sequence = 0,
    pending: Capture["records"] = [],
    bytes = 0;
  let metadata: RawObject = {},
    profile: RawObject | undefined,
    expectedUserId = request.expectedUserId;
  let postsReceived = 0;
  const warnings: string[] = [];
  const descriptor = {
    origin: client.origin,
    resource: request.kind,
    input: request.input,
    since: request.since,
    until: request.until,
    cursor: request.cursor,
    refresh: request.refresh,
    format: request.format ?? "json",
  };
  const flush = async (terminal: Capture["terminal"]) => {
    if (!pending.length && terminal === "more") return;
    await onStage?.("Saving raw capture");
    const receipt = await sink({
      version: 1,
      runId: request.runId,
      attempt: request.attempt,
      sequence,
      source: "x-md",
      request: descriptor,
      records: pending,
      terminal,
    });
    await onReceipt(receipt, pending.length);
    pending = [];
    bytes = 0;
    sequence++;
  };
  const add = async (payload: RawObject, part?: Capture["records"][number]["part"]) => {
    const size = measure(payload);
    if (size > CAPTURE_BUDGET)
      throw new ProviderError(
        "oversized_record",
        "A provider record is too large for this handoff. It was not shortened or normalized.",
      );
    if (pending.length && (pending.length >= RECORDS_PER_CAPTURE || bytes + size > CAPTURE_BUDGET))
      await flush("more");
    pending.push({ receivedAt: now(), payload, ...(part ? { part } : {}) });
    bytes += size;
  };
  // One history page can hold up to MAX_POSTS_PER_PAGE posts, which is more
  // than a single 4 MB capture can carry. Hand the page off in parts rather
  // than failing the whole import with `capture_too_large`; the parts flush
  // into separate captures through `add` above.
  const addHistory = async (envelope: RawObject) => {
    const parts = splitHistoryPage(envelope);
    if (parts.length === 1) return add(envelope);
    const totalPosts = Array.isArray(envelope.posts) ? envelope.posts.length : 0;
    for (const [index, payload] of parts.entries())
      await add(payload, { index, of: parts.length, totalPosts });
  };
  try {
    if (request.kind === "bulk") {
      await onStage?.("Checking account identity");
      // Pin numeric identity before history collection, just like the old collector.
      const response = await client.read("profile", request.input);
      descriptor.resource = "profile";
      descriptor.format = "json";
      await add(response);
      await flush("more");
      descriptor.resource = "bulk";
      descriptor.format = request.format ?? "json";
      profile = record(response.profile);
      const id = string(profile.id);
      if (!id || !/^\d+$/.test(id))
        throw new ProviderError(
          "missing_identity",
          "x.md did not return a stable account ID. Raw profile was handed off for inspection.",
        );
      if (expectedUserId && expectedUserId !== id)
        throw new ProviderError(
          "identity_mismatch",
          "This handle now resolves to a different account. Collection was stopped before importing its history.",
        );
      expectedUserId = id;
      await onIdentity?.(id);
      await onStage?.("Fetching account history from x.md");
      let terminal: RawObject | undefined;
      const options = {
        // Ask for the provider's documented per-request maximum. x.md returns
        // `meta.truncated` when a range exceeds it, and `nextUntil` continues
        // from `meta.oldest`, so a larger page never loses posts — it just
        // spends far fewer requests against the provider's own allowance.
        maxPosts: MAX_POSTS_PER_PAGE,
        since: request.since,
        until: request.until,
        refresh: request.refresh,
      };
      if (request.format !== "ndjson") {
        const response = await client.history(request.input, options);
        // Preserve the complete provider envelope, including future fields.
        await addHistory(response);
        if (!Array.isArray(response.posts) || !response.meta)
          throw new ProviderError(
            "invalid_history",
            "x.md history is missing posts or its completion summary.",
          );
        metadata = record(response.meta);
        postsReceived = response.posts.length;
        if (response.posts.length > options.maxPosts)
          throw new ProviderError("import_limit", "x.md exceeded the requested history size.");
        // x.md's own /posts endpoint omits the embedded `profile` field on
        // continuation requests (any call carrying `until`), even though the
        // rest of the envelope is a fully valid, complete page. Identity was
        // already pinned via the dedicated profile fetch above, so its
        // absence is tolerated ONLY on continuation requests -- treating it
        // as malformed there would permanently stop every import after the
        // first page (the exact "stops at ~500 posts" bug). A first (non-
        // continuation) response must still include it, and whenever a
        // profile IS present -- continuation or not -- it is still checked
        // against the pinned identity.
        if (request.until === undefined && !response.profile)
          throw new ProviderError(
            "invalid_history",
            "x.md history is missing its embedded profile on a first (non-continuation) page.",
          );
        if (
          response.profile !== undefined &&
          string(record(response.profile).id) !== expectedUserId
        )
          throw new ProviderError(
            "identity_mismatch",
            "Account identity changed during history collection. Raw captures need downstream review.",
          );
      } else
        for await (const event of client.bulk(request.input, options)) {
          if ("meta" in event) {
            metadata = record(event.meta);
            terminal = event;
          } else await add(event);
        }
      // A terminal provider record is accepted only after a clean stream EOF.
      if (terminal) {
        await add(terminal);
        const finalProfile = terminal.profile ? record(terminal.profile) : undefined;
        if (finalProfile && string(finalProfile.id) !== expectedUserId)
          throw new ProviderError(
            "identity_mismatch",
            "Account identity changed during the import. Raw captures need downstream review.",
          );
      }
      if (metadata.truncated)
        warnings.push(
          request.format === "ndjson"
            ? "This unordered stream was capped. No oldest-based continuation is safe; repeat the range using JSON history."
            : "More posts are available from x.md.",
        );
      if (metadata.floor_reached)
        warnings.push(
          "Reached the history available from X; this does not guarantee a complete account archive.",
        );
    } else {
      await onStage?.(`Fetching ${request.kind} from x.md`);
      const response = await client.read(
        request.kind === "live" ? "search" : request.kind,
        request.input,
        request.cursor,
      );
      await add(response);
      metadata = response;
      if (response.degraded)
        warnings.push(
          "x.md returned web-indexed search results because live search was unavailable.",
        );
    }
    if (Array.isArray(metadata.warnings))
      warnings.push(
        ...metadata.warnings
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.slice(0, 500)),
      );
    await flush("complete");
    return {
      warnings,
      expectedUserId,
      nextUntil:
        request.kind === "bulk" && request.format !== "ndjson" && metadata.truncated
          ? string(metadata.oldest)
          : undefined,
      nextCursor: string(metadata.nextCursor),
      profile,
      postsReceived,
      oldest: string(metadata.oldest),
      floorReached: metadata.floor_reached === true,
    };
  } catch (error) {
    if (error instanceof ProviderError && error.raw) await add(error.raw).catch(() => {});
    // Best effort preserves observed raw data. A failed handoff never gets an ack.
    await flush("partial").catch(() => {});
    throw error;
  }
}
