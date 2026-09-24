import {
  XmdClient,
  ProviderError,
  record,
  string,
  MAX_POSTS_PER_PAGE,
  MAX_CHAIN_CONCURRENCY,
  type RawObject,
} from "./xmd";
import { CAPTURE_MAX_BYTES, jsonBytes, type Capture, type Receipt } from "./handoff";

/**
 * Bytes of provider payload allowed in one capture. `deliverCapture` rejects a
 * capture body over `CAPTURE_MAX_BYTES` outright (`capture_too_large`), so this
 * leaves ~1 MB for the capture envelope, per-record metadata, and any UTF-8
 * accounting drift — derived from that ceiling rather than restated, so raising
 * the receiver's limit cannot leave this slicing to a stale size. It is a
 * transport budget, not a usage budget: it never slows, paces, or caps what we
 * ask the provider for.
 */
const CAPTURE_BUDGET = CAPTURE_MAX_BYTES - 1_000_000;
/** Per-record allowance for the `part` metadata and record framing. */
const RECORD_OVERHEAD = 256;
/** Ordinary stream records per capture (docs/integration-contract.md). */
const RECORDS_PER_CAPTURE = 25;
/** A payload and the serialized size that was measured while producing it. */
export type SizedPayload = { payload: RawObject; bytes: number };
/**
 * Split one oversized history page into envelope-shaped parts that each fit in
 * a capture. Every part repeats the page's own envelope (profile, meta, and any
 * unknown fields) verbatim and carries a disjoint, in-order slice of `posts`,
 * so concatenating the slices reproduces the provider's page exactly. Slicing
 * is driven by measured serialized bytes, never an assumed posts-per-capture
 * count: real captures on this machine range from ~2.1 KB to ~6.2 KB per post.
 *
 * A 5,000-post page is 11-15 MB, so it is measured exactly once: each post is
 * serialized a single time and every other figure — the whole page's size, and
 * each part's — is arithmetic on those bytes. Each part carries its size out so
 * the caller never serializes it again.
 */
export function splitHistoryPage(envelope: RawObject, budget = CAPTURE_BUDGET): SizedPayload[] {
  const posts = envelope.posts;
  if (!Array.isArray(posts) || posts.length < 2)
    return [{ payload: envelope, bytes: jsonBytes(envelope) }];
  // `{...envelope, posts: []}` keeps the provider's key order, so this is the
  // exact fixed cost every part pays before its own posts are added: a part is
  // this envelope, its posts' own bytes, and one comma between each pair.
  const empty = jsonBytes({ ...envelope, posts: [] });
  const sizes = posts.map((post) => jsonBytes(post));
  // Exactly what serializing the whole page would report, without doing it:
  // the empty envelope, every post, and the n-1 commas between them.
  const whole = sizes.reduce((total, size) => total + size, empty + posts.length - 1);
  if (whole <= budget) return [{ payload: envelope, bytes: whole }];
  const overhead = empty + RECORD_OVERHEAD;
  const parts: SizedPayload[] = [];
  let slice: unknown[] = [];
  let size = overhead;
  const push = () => parts.push({ payload: { ...envelope, posts: slice }, bytes: size });
  for (const [index, post] of posts.entries()) {
    const cost = sizes[index] + 1; // the separating comma
    if (slice.length && size + cost > budget) {
      push();
      slice = [];
      size = overhead;
    }
    slice.push(post);
    size += cost;
  }
  if (slice.length) push();
  return parts;
}

/**
 * One history page, tried a second time with the provider's maximum chain
 * concurrency when x.md itself ran out of time on the first. x.md's gateway
 * answers 504 at about two minutes; in production the huggingface and
 * lauren_tan pages died there at every page size, so the page size is not
 * the lever — how fast x.md assembles the page is. This is a single extra
 * request, never pacing or a budget.
 */
async function historyPage(
  client: XmdClient,
  input: string,
  options: Parameters<XmdClient["history"]>[1],
  onStage?: (phase: string) => Promise<void>,
): Promise<RawObject> {
  try {
    return await client.history(input, options);
  } catch (error) {
    const gaveUp =
      error instanceof ProviderError &&
      (error.code === "provider_timeout" || error.code === "http_504");
    if (!gaveUp || options.concurrency !== undefined) throw error;
    await onStage?.(`x.md ran out of time; asking again with ${MAX_CHAIN_CONCURRENCY} chains`);
    return client.history(input, { ...options, concurrency: MAX_CHAIN_CONCURRENCY });
  }
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
  // `size` is the payload's serialized bytes. Split history parts were already
  // measured while being sliced, so they pass theirs in rather than paying for
  // a second serialization of an up-to-3 MB record.
  const add = async (
    payload: RawObject,
    size = jsonBytes(payload),
    part?: Capture["records"][number]["part"],
  ) => {
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
    if (parts.length === 1) return add(parts[0].payload, parts[0].bytes);
    const totalPosts = Array.isArray(envelope.posts) ? envelope.posts.length : 0;
    for (const [index, part] of parts.entries())
      await add(part.payload, part.bytes, { index, of: parts.length, totalPosts });
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
        const response = await historyPage(client, request.input, options, onStage);
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
