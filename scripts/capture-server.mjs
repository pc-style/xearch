import { createServer } from "node:http";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir, open, rename, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Whether an untrusted capture value is a string, without relying on `typeof`. */
function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

export function captureServer({ directory, token }) {
  if (!token) throw new Error("A capture token is required");

  const authorized = (value) => {
    const a = Buffer.from(value ?? ""),
      b = Buffer.from(`Bearer ${token}`);

    return a.length === b.length && timingSafeEqual(a, b);
  };

  return createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/health")
      return reply(200, { status: "ready", mode: "temporary-raw-capture" });

    if (req.method !== "POST" || req.url !== "/captures") return reply(404, { error: "not_found" });

    if (!authorized(req.headers.authorization)) return reply(401, { error: "unauthorized" });
    let temporary;

    try {
      const chunks = [];
      let size = 0;

      for await (const chunk of req) {
        size += chunk.length;

        if (size > 4_000_000) {
          reply(413, { error: "too_large" });

          return;
        }

        chunks.push(chunk);
      }

      const body = Buffer.concat(chunks);
      const id = createHash("sha256").update(body).digest("hex");

      if (req.headers["idempotency-key"] !== id) return reply(400, { error: "checksum_mismatch" });
      let capture;

      try {
        capture = JSON.parse(body.toString("utf8"));
      } catch {
        return reply(400, { error: "invalid_json" });
      }

      if (
        capture.version !== 1 ||
        !isString(capture.runId) ||
        !Array.isArray(capture.records) ||
        !["more", "complete", "partial"].includes(capture.terminal)
      )
        return reply(400, { error: "invalid_capture" });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = resolve(directory, `${id}.json`);
      temporary = resolve(directory, `${id}.${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);

      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }

      // Identical hashes have identical bytes. Rename publishes only a fully synced file.
      await rename(temporary, target);
      temporary = undefined;
      const dir = await open(directory, "r");

      try {
        await dir.sync();
      } finally {
        await dir.close();
      }

      reply(200, { captureId: id, durable: true, receiptId: `local:${id}` });
    } catch {
      if (temporary) await unlink(temporary).catch(() => {});

      if (!res.headersSent) reply(500, { error: "capture_not_acknowledged" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(".local-captures/raw");
  const token = (await readFile(resolve(".local-captures/token"), "utf8")).trim();
  const server = captureServer({ directory, token });
  server.requestTimeout = 30_000;
  server.listen(4319, "127.0.0.1", () =>
    console.log("Temporary capture receiver: http://127.0.0.1:4319 (loopback only)"),
  );
}
