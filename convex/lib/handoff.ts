import { z } from "zod";
import { ProviderError, readThrottle, retryDelay, type RawObject, type JsonValue } from "./xmd";

/** Acquisition output only. The receiving service owns raw retention and normalization. */
export type Capture = {
  version: 1;
  runId: string;
  attempt: number;
  sequence: number;
  source: "x-md" | "firecrawl";
  request: {
    origin: string;
    resource: string;
    input: string;
    since?: string;
    until?: string;
    cursor?: string;
    refresh?: boolean;
    format?: "json" | "ndjson";
  };
  records: {
    receivedAt: number;
    payload: RawObject;
    /**
     * Present only when one provider page was too large for a single capture
     * and its `posts` were split across several records. Each part repeats the
     * page envelope verbatim and carries a disjoint, in-order slice of `posts`;
     * concatenating parts 0..of-1 reproduces the original page. See
     * docs/integration-contract.md.
     */
    part?: { index: number; of: number; totalPosts: number };
  }[];
  terminal: "more" | "complete" | "partial";
};

/**
 * The receiver's hard ceiling on one capture body, in bytes. Exported because
 * the splitter in convex/lib/collect.ts derives its slicing budget from it:
 * raising this must move that budget with it, never leave it slicing to a
 * stale size.
 */
export const CAPTURE_MAX_BYTES = 4_000_000;

// One encoder for the whole process: `new TextEncoder()` per measurement cost
// an allocation per post on the import hot path.
const encoder = new TextEncoder();

/** UTF-8 bytes of an already-serialized body. */
export const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

/** UTF-8 bytes of a value once serialized — the unit every capture budget is in. */
export const jsonBytes = (value: JsonValue): number => utf8Bytes(JSON.stringify(value));

const receiptSchema = z.object({
  captureId: z.string(),
  durable: z.literal(true),
  receiptId: z.string().min(1).max(200),
});

export type Receipt = z.infer<typeof receiptSchema>;

export async function captureId(body: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(body));

  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function deliverCapture(
  url: string,
  token: string | undefined,
  capture: Capture,
  fetcher: typeof fetch = fetch,
): Promise<Receipt> {
  const body = JSON.stringify(capture);

  if (utf8Bytes(body) > CAPTURE_MAX_BYTES)
    throw new ProviderError(
      "capture_too_large",
      "A raw capture exceeded 4 MB. No data was truncated; downstream transport must support this record before retrying.",
    );
  const id = await captureId(body);

  // Same bytes and idempotency key on a transport retry, including lost responses.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;

    try {
      const baseHeaders = {
        "Content-Type": "application/json",
        "Idempotency-Key": id,
      } satisfies Record<string, string>;

      const headers = token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders;

      response = await fetcher(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt === 0) continue;
      throw new ProviderError(
        "handoff_unavailable",
        "The storage service did not acknowledge the raw capture. The import is incomplete.",
        30_000,
        true,
      );
    }

    if (!response.ok) {
      let problem: JsonValue | undefined;

      try {
        problem = await response.json();
      } catch {
        /* status is still actionable */
      }

      throw new ProviderError(
        "handoff_rejected",
        `The storage service rejected the raw capture (${response.status}).`,
        retryDelay(response.headers.get("Retry-After")),
        response.status === 429 || response.status >= 500,
        undefined,
        readThrottle("receiver", "capture-handoff", response.status, response.headers, problem),
      );
    }

    const parsed = receiptSchema.safeParse(await response.json());

    if (!parsed.success || parsed.data.captureId !== id)
      throw new ProviderError(
        "invalid_receipt",
        "Storage must acknowledge this exact capture with durable:true before indexing progress can advance.",
      );

    return parsed.data;
  }

  throw new Error("Unreachable");
}
