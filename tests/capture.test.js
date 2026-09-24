import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureServer } from "../scripts/capture-server.mjs";

const cleanup = [];

afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "xearch-capture-test-"));
  const server = captureServer({ directory, token: "test-token" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/captures`;

  const body = JSON.stringify({
    version: 1,
    runId: "../../not-a-path",
    records: [{ payload: { untouched: [1, 2] } }],
    terminal: "complete",
  });

  const id = createHash("sha256").update(body).digest("hex");

  const send = (headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Idempotency-Key": id,
        ...headers,
      },
      body,
    });

  return { directory, body, id, send };
}

it("retains exact capture bytes and returns identical receipts on replay", async () => {
  const { directory, body, id, send } = await setup();

  const first = await (await send()).json(),
    second = await (await send()).json();

  expect(first).toEqual({
    captureId: id,
    durable: true,
    receiptId: `local:${id}`,
  });
  expect(second).toEqual(first);
  expect(await readFile(join(directory, `${id}.json`), "utf8")).toBe(body);
  expect(await readdir(directory)).toEqual([`${id}.json`]);
});

it("rejects invalid credentials and mismatched checksums without writing data", async () => {
  const { directory, send } = await setup();
  expect((await send({ Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await send({ "Idempotency-Key": "wrong" })).status).toBe(400);
  expect(await readdir(directory)).toEqual([]);
});
