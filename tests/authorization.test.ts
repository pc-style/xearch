import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { isOperatorEmail } from "../convex/access";

const modules = import.meta.glob("../convex/**/*.ts");

/**
 * Authorization boundary for provider-spending actions (adam's decision,
 * 2026-09-24): ordinary search stays public, but starting/retrying an
 * import, and cancel/dismiss/restore on a job, require a signed-in OPERATOR
 * — a caller whose verified email is listed in OPERATOR_EMAILS. An
 * anonymous session and a verified-but-unlisted email are both refused the
 * same way, so the allowlist itself is never confirmed or denied to the
 * caller.
 *
 * The verified email comes ONLY from the `users` row's own
 * `emailVerificationTime`/`email` fields (set by convex/auth.ts's Email OTP
 * provider once a code is confirmed) — never from
 * `ctx.auth.getUserIdentity().email`, which is an optional JWT claim with no
 * tie to verification (CodeRabbit #4089340875, CWE-863). Every identity
 * below therefore carries its email on the seeded `users` DOCUMENT, not on
 * `t.withIdentity`'s JWT-claim argument, so these tests fail if
 * `requireOperator` ever starts trusting the claim again.
 *
 * tests/setupEnv.ts sets OPERATOR_EMAILS to
 * "alice@test.xearch,bob@test.xearch,operator@test.xearch" for every test in
 * this suite; this file additionally exercises identities NOT on that list.
 */

async function insertUser(
  t: ReturnType<typeof convexTest>,
  fields: { isAnonymous: boolean; email?: string; verified?: boolean },
) {
  return t.run((ctx) =>
    ctx.db.insert("users", {
      isAnonymous: fields.isAnonymous,
      email: fields.email,
      emailVerificationTime: fields.verified ? Date.now() : undefined,
    }),
  );
}

async function setup() {
  const t = convexTest(schema, modules);

  // A verified email ON the OPERATOR_EMAILS allowlist, stored on the `users`
  // row. The identity below deliberately carries NO `email` JWT claim, so
  // any test using it only passes if the fix reads the DB row.
  const operatorUser = await insertUser(t, {
    isAnonymous: false,
    email: "operator@test.xearch",
    verified: true,
  });

  const guestUser = await insertUser(t, { isAnonymous: true });

  // A verified email that is NOT on the allowlist.
  const outsiderUser = await insertUser(t, {
    isAnonymous: false,
    email: "outsider@test.xearch",
    verified: true,
  });

  // An allowlisted email the user has never verified — must be refused
  // exactly like an outsider, not treated as "close enough".
  const unverifiedUser = await insertUser(t, {
    isAnonymous: false,
    email: "operator@test.xearch",
    verified: false,
  });

  // No email at all on the `users` row (nothing verified), but the JWT
  // itself claims an allowlisted address — simulating a forged or
  // misconfigured `email` claim. Must be refused: the claim is never
  // trusted, only the row.
  const spoofedUser = await insertUser(t, { isAnonymous: false });

  return {
    t,
    operator: t.withIdentity({ subject: `${operatorUser}|s` }),
    guest: t.withIdentity({ subject: `${guestUser}|s` }),
    outsider: t.withIdentity({ subject: `${outsiderUser}|s` }),
    unverified: t.withIdentity({ subject: `${unverifiedUser}|s` }),
    spoofed: t.withIdentity({ subject: `${spoofedUser}|s`, email: "operator@test.xearch" }),
  };
}

describe("the operator authorization boundary", () => {
  beforeEach(() => {
    vi.stubEnv("X_MD_API_KEY", "test");
    vi.stubEnv("RAW_CAPTURE_URL", "http://127.0.0.1:4319/captures");
    vi.stubEnv("COLLECTOR_MODE", "receiver");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("access.isOperator reports true only for a verified, allowlisted email", async () => {
    const { operator, guest, outsider, unverified, spoofed } = await setup();
    expect(await operator.query(api.access.isOperator, {})).toBe(true);
    expect(await guest.query(api.access.isOperator, {})).toBe(false);
    expect(await outsider.query(api.access.isOperator, {})).toBe(false);
    expect(await unverified.query(api.access.isOperator, {})).toBe(false);
    expect(await spoofed.query(api.access.isOperator, {})).toBe(false);
  });

  it("refuses an allowlisted email the user has never verified (CodeRabbit #4089340875)", async () => {
    const { unverified } = await setup();
    await expect(
      unverified.mutation(api.jobs.start, { kind: "live", input: "from:theo" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("ignores a forged/misconfigured JWT `email` claim and reads the `users` row instead (CodeRabbit #4089340875)", async () => {
    const { spoofed } = await setup();
    await expect(
      spoofed.mutation(api.jobs.start, { kind: "live", input: "from:theo" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it('admits every verified address on a domain listed as "@domain", and nothing else', async () => {
    vi.stubEnv("OPERATOR_EMAILS", "@pcstyle.dev, someone@else.example");
    const t = convexTest(schema, modules);

    const onDomain = await insertUser(t, {
      isAnonymous: false,
      email: "Adam@PCstyle.dev",
      verified: true,
    });

    const lookalike = await insertUser(t, {
      isAnonymous: false,
      email: "adam@notpcstyle.dev",
      verified: true,
    });

    const subdomain = await insertUser(t, {
      isAnonymous: false,
      email: "adam@mail.pcstyle.dev",
      verified: true,
    });

    const unverifiedOnDomain = await insertUser(t, {
      isAnonymous: false,
      email: "guest@pcstyle.dev",
      verified: false,
    });

    const as = (id: string) => t.withIdentity({ subject: `${id}|s` });
    expect(await as(onDomain).query(api.access.isOperator, {})).toBe(true);
    expect(await as(lookalike).query(api.access.isOperator, {})).toBe(false);
    expect(await as(subdomain).query(api.access.isOperator, {})).toBe(false);
    expect(await as(unverifiedOnDomain).query(api.access.isOperator, {})).toBe(false);
  });

  it("does not let a bare domain entry match a malformed address", () => {
    const entries = new Set(["@pcstyle.dev"]);
    expect(isOperatorEmail("me@pcstyle.dev", entries)).toBe(true);
    expect(isOperatorEmail("@pcstyle.dev", entries)).toBe(false);
    expect(isOperatorEmail("pcstyle.dev", entries)).toBe(false);
    expect(isOperatorEmail("me@", entries)).toBe(false);
  });

  it("fails closed when OPERATOR_EMAILS is unset or empty, even for a verified allowlisted-looking email", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "");
    const { operator } = await setup();
    await expect(
      operator.mutation(api.jobs.start, { kind: "live", input: "from:theo" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("refuses jobs.start for an anonymous guest", async () => {
    const { guest } = await setup();
    await expect(
      guest.mutation(api.jobs.start, { kind: "live", input: "from:theo" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("refuses jobs.start for a verified email not on OPERATOR_EMAILS", async () => {
    const { outsider } = await setup();
    await expect(
      outsider.mutation(api.jobs.start, { kind: "live", input: "from:theo" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("allows jobs.start for an operator", async () => {
    const { operator } = await setup();
    const jobId = await operator.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    expect(jobId).toBeTruthy();
  });

  it("refuses cancel/dismiss/restore for a non-operator, even on a job someone else started", async () => {
    const { t, operator, guest, outsider } = await setup();
    const jobId = await operator.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    await t.run((ctx) => ctx.db.patch(jobId, { status: "failed" }));

    await expect(guest.mutation(api.jobs.cancel, { jobId })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    await expect(outsider.mutation(api.jobs.retry, { jobId })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    await expect(guest.mutation(api.jobs.dismiss, { jobId })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    await expect(outsider.mutation(api.jobs.restore, { jobId })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
  });

  it("allows an operator to cancel/dismiss/restore a job, including one a different operator started", async () => {
    const { t, operator } = await setup();

    const otherOperatorUser = await insertUser(t, {
      isAnonymous: false,
      email: "bob@test.xearch",
      verified: true,
    });

    const otherOperator = t.withIdentity({ subject: `${otherOperatorUser}|s` });

    const jobId = await otherOperator.mutation(api.jobs.start, {
      kind: "live",
      input: "from:theo",
    });

    // Jobs are shared infrastructure (to-do.md); a different operator may
    // act on a run they did not personally start.
    await operator.mutation(api.jobs.cancel, { jobId });
    const cancelled = await t.run((ctx) => ctx.db.get(jobId));
    expect(cancelled?.status).toBe("cancelled");
  });

  it("still lets an anonymous (or any signed-in) caller read the job feed and receipts — only the provider-spending actions are gated", async () => {
    const { t, operator, guest } = await setup();
    const jobId = await operator.mutation(api.jobs.start, { kind: "live", input: "from:theo" });
    await t.run((ctx) => ctx.db.patch(jobId, { status: "complete" }));
    const feed = await guest.query(api.jobs.list, {});
    expect(feed.jobs.map((j) => j._id)).toContain(jobId);
    await expect(guest.query(api.jobs.receipts, { jobId })).resolves.toEqual([]);
  });
});

/**
 * The operator build's own token (src/operatorToken.ts, `OPERATOR_TOKEN` on
 * the deployment) is a second, independent path into `requireOperator` —
 * the primary one, since the operator site needs no email sign-in at all
 * (adam's decision, 2026-09-24: being on the operator site, already
 * restricted by exe.dev's own login, IS the operator proof). It must never
 * weaken the allowlist path above: a caller with neither a matching token
 * nor an allowlisted email is still refused, and an unset `OPERATOR_TOKEN`
 * disables the token path entirely rather than falling back to some
 * always-true default.
 */
describe("the operator token path", () => {
  beforeEach(() => {
    vi.stubEnv("X_MD_API_KEY", "test");
    vi.stubEnv("RAW_CAPTURE_URL", "http://127.0.0.1:4319/captures");
    vi.stubEnv("COLLECTOR_MODE", "receiver");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows an anonymous session that presents the matching token", async () => {
    vi.stubEnv("OPERATOR_TOKEN", "correct-horse-battery-staple");

    const { guest } = await setup();

    const jobId = await guest.mutation(api.jobs.start, {
      kind: "live",
      input: "from:theo",
      operatorToken: "correct-horse-battery-staple",
    });

    expect(jobId).toBeTruthy();
  });

  it("refuses a wrong token from an otherwise-unlisted caller", async () => {
    vi.stubEnv("OPERATOR_TOKEN", "correct-horse-battery-staple");
    const { guest } = await setup();
    await expect(
      guest.mutation(api.jobs.start, {
        kind: "live",
        input: "from:theo",
        operatorToken: "wrong-guess",
      }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("refuses a missing token from an otherwise-unlisted caller", async () => {
    vi.stubEnv("OPERATOR_TOKEN", "correct-horse-battery-staple");
    const { guest } = await setup();
    await expect(
      guest.mutation(api.jobs.start, { kind: "live", input: "from:theo" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("disables the token path entirely when OPERATOR_TOKEN is unset, even for a caller presenting one", async () => {
    // No vi.stubEnv("OPERATOR_TOKEN", ...) here — it stays unset.
    const { guest } = await setup();
    await expect(
      guest.mutation(api.jobs.start, {
        kind: "live",
        input: "from:theo",
        operatorToken: "anything",
      }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("still requires a real session even with a matching token", async () => {
    vi.stubEnv("OPERATOR_TOKEN", "correct-horse-battery-staple");
    const t = convexTest(schema, modules);
    // No `t.withIdentity(...)`: an unauthenticated caller, not merely an
    // anonymous one — `getAuthUserId` returns null either way, but this
    // pins down that the token alone is not a substitute for any session.
    await expect(
      t.mutation(api.jobs.start, {
        kind: "live",
        input: "from:theo",
        operatorToken: "correct-horse-battery-staple",
      }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("access.isOperator reports true for a matching token from an anonymous session", async () => {
    vi.stubEnv("OPERATOR_TOKEN", "correct-horse-battery-staple");
    const { guest } = await setup();
    expect(
      await guest.query(api.access.isOperator, { operatorToken: "correct-horse-battery-staple" }),
    ).toBe(true);
    expect(await guest.query(api.access.isOperator, { operatorToken: "wrong" })).toBe(false);
  });

  // CodeRabbit #4090910221: OPERATOR_TOKEN_PREVIOUS exists so a rotation
  // (new token baked into a not-yet-republished bundle, or an
  // already-republished bundle against a not-yet-updated deployment) has no
  // gap where the operator site's token path stops working.
  it("also accepts OPERATOR_TOKEN_PREVIOUS, so a not-yet-republished bundle's old token still works during a rotation", async () => {
    vi.stubEnv("OPERATOR_TOKEN", "new-token");
    vi.stubEnv("OPERATOR_TOKEN_PREVIOUS", "old-token");

    const { guest } = await setup();

    await expect(
      guest.mutation(api.jobs.start, {
        kind: "live",
        input: "from:theo",
        operatorToken: "new-token",
      }),
    ).resolves.toBeTruthy();
    await expect(
      guest.mutation(api.jobs.start, {
        kind: "live",
        input: "from:otherperson",
        operatorToken: "old-token",
      }),
    ).resolves.toBeTruthy();
  });

  it("does not accept OPERATOR_TOKEN_PREVIOUS's value when it is unset, even if a caller guesses it", async () => {
    vi.stubEnv("OPERATOR_TOKEN", "new-token");
    // No OPERATOR_TOKEN_PREVIOUS stubbed here — it stays unset.
    const { guest } = await setup();
    await expect(
      guest.mutation(api.jobs.start, {
        kind: "live",
        input: "from:theo",
        operatorToken: "old-token",
      }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });
});

/**
 * convex/integrations.ts's readLink/webContext/interpret/account all spend
 * Firecrawl, OpenAI, or x.md allowance and funnel through the same
 * `reserve` internal mutation right before they do (readLink also checks
 * up front, so even its cache-hit path is gated). Testing `reserve` directly
 * covers the shared gate once; readLink/interpret's own end-to-end success
 * with an operator identity is already exercised in tests/convex.test.ts.
 */
describe("convex/integrations.ts's provider-spending actions", () => {
  beforeEach(() => {
    vi.stubEnv("X_MD_API_KEY", "test");
  });

  it("reserve (the shared gate behind readLink/webContext/interpret/account) allows an operator", async () => {
    const { operator } = await setup();
    await expect(
      operator.mutation(internal.integrations.reserve, { service: "xmd" }),
    ).resolves.toBeNull();
  });

  it("reserve refuses an anonymous guest", async () => {
    const { guest } = await setup();
    await expect(
      guest.mutation(internal.integrations.reserve, { service: "firecrawl" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("reserve refuses a verified email not on OPERATOR_EMAILS", async () => {
    const { outsider } = await setup();
    await expect(
      outsider.mutation(internal.integrations.reserve, { service: "openai" }),
    ).rejects.toThrow("Sign in as an operator to import.");
  });

  it("readLink refuses an anonymous guest before ever calling Firecrawl, even on what would be a cache hit", async () => {
    const { t, guest } = await setup();
    const fetcher = vi.fn<typeof fetch>();

    vi.stubGlobal("fetch", fetcher);
    // A fresh cached page for the exact URL requested, keyed the same way
    // `readLink` normalizes it (`publicUrl` — `new URL(...).toString()`
    // adds the trailing slash). Without this row, the test would only ever
    // exercise the cache-MISS path even though its name claims otherwise
    // (CodeRabbit #4089340906) — this makes it a real regression guard if
    // `requireOperator` is ever moved below the cache lookup.
    await t.run((ctx) =>
      ctx.db.insert("pages", {
        url: "https://example.com/",
        title: "Cached",
        text: "cached body",
        collectedAt: Date.now(),
      }),
    );
    await expect(
      guest.action(api.integrations.readLink, { url: "https://example.com" }),
    ).rejects.toThrow("Sign in as an operator to import.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("webContext refuses an anonymous guest before ever calling Firecrawl", async () => {
    const { guest } = await setup();
    const fetcher = vi.fn<typeof fetch>();

    vi.stubGlobal("fetch", fetcher);
    await expect(guest.action(api.integrations.webContext, { query: "convex" })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("interpret refuses an anonymous guest before ever calling OpenAI", async () => {
    const { guest } = await setup();
    const fetcher = vi.fn<typeof fetch>();

    vi.stubGlobal("fetch", fetcher);
    await expect(guest.action(api.integrations.interpret, { raw: "convex talks" })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("account refuses an anonymous guest before ever calling x.md", async () => {
    const { guest } = await setup();
    const fetcher = vi.fn<typeof fetch>();

    vi.stubGlobal("fetch", fetcher);
    await expect(guest.action(api.integrations.account, { handle: "theo" })).rejects.toThrow(
      "Sign in as an operator to import.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("account allows an operator, and only then calls x.md", async () => {
    const { operator } = await setup();

    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ profile: { userId: "1", handle: "theo", name: "Theo" } }),
    );

    vi.stubGlobal("fetch", fetcher);

    const result = await operator.action(api.integrations.account, { handle: "theo" });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ userId: "1", handle: "theo" });
  });
});
