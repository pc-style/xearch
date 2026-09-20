/// <reference types="vite/client" />
// P1 product journey (application side): durable email sign-in on top of the
// stock @convex-dev/auth Email provider (convex/auth.ts), delivered through
// AgentMail's existing send/retry machinery (no second mail outbox), plus the
// digest preview/explicit-send pair in convex/email.ts and its ownership
// checks. No email is ever actually sent here: the AgentMail client class is
// mocked at its boundary (see `sendMessage` below), and `fetch` is stubbed to
// fail loudly if anything ever tried to reach the network anyway.
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { convexTest, type TestConvex } from "convex-test";
import { getFunctionName } from "convex/server";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

type T = TestConvex<typeof schema>;
type SentMessage = { to?: string | string[]; subject?: string; text?: string };

// @convex-dev/auth signs real JWTs (RS256) even inside convex-test, so a
// throwaway keypair is required - generated fresh per test run, never
// persisted, and unrelated to any real deployment key.
const { privateKey: JWT_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const { sendMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn<(ctx: unknown, inboxId: string, message: SentMessage) => Promise<string>>(
    async () => "outbound_test_id",
  ),
}));

vi.mock("@agentmail/convex", () => ({
  AgentMail: vi.fn().mockImplementation(function AgentMail() {
    return { sendMessage, status: vi.fn() };
  }),
}));

// For the src/auth/*.tsx render smoke tests below only: same
// mock-convex/react-by-function-name pattern as tests/library-ui.test.ts, so
// EmailSignIn/AccountBadge can be rendered against fixture query results
// without a real ConvexProvider or a jsdom/testing-library dependency
// (neither is installed - see the "component rendering" describe block's
// leading comment for why this is static-markup-only).
const authUiResponses = vi.hoisted(() => new Map<string, unknown>());
const authUiActions = vi.hoisted(() => ({ signIn: vi.fn(), signOut: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => authUiResponses.get(getFunctionName(ref)),
}));

vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => authUiActions,
}));

const modules = import.meta.glob("../convex/**/*.ts");

// Imported after the mocks above so both components pick up the mocked
// convex/react + @convex-dev/auth/react hooks instead of the real ones.
const { EmailSignIn } = await import("../src/auth/EmailSignIn");
const { AccountBadge } = await import("../src/auth/AccountBadge");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sendMessage.mockClear();
  authUiResponses.clear();
  authUiActions.signIn.mockClear();
  authUiActions.signOut.mockClear();
});

function setup(opts: { stubRequireVerifiedEmail?: boolean } = {}): T {
  const { stubRequireVerifiedEmail = true } = opts;
  const t = convexTest(schema, modules);
  vi.stubEnv("AGENTMAIL_API_KEY", "test-key");
  vi.stubEnv("AGENTMAIL_INBOX_ID", "inbox_test");
  // convex/email.ts's verified-email/matching-recipient gate in `send` is
  // unconditional and does not read this variable any more; it is stubbed
  // here only to prove that stubbing it (true, or not at all - see the
  // "defaults to blocking" test below) makes no difference to the outcome,
  // i.e. there is no fail-open path left for an unset/misconfigured flag.
  if (stubRequireVerifiedEmail) vi.stubEnv("REQUIRE_VERIFIED_EMAIL", "true");
  // @convex-dev/auth builds a magic-link `url` alongside the OTP `token` even
  // for our code-only flow; it needs SITE_URL set to do that, though our
  // sendVerificationRequest (convex/auth.ts) never uses that url field.
  vi.stubEnv("SITE_URL", "https://xearch.test");
  vi.stubEnv("CONVEX_SITE_URL", "https://xearch-test.convex.site");
  vi.stubEnv("JWT_PRIVATE_KEY", JWT_PRIVATE_KEY);
  // No test in this file should ever cause a real outbound fetch; if one
  // does, this stub makes it fail immediately instead of hitting a network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("No test in tests/journey.test.ts may perform a real network call.");
    }),
  );
  return t;
}

/** Drive the two-step OTP flow exactly as src/auth/EmailSignIn.tsx does, and
 * read the code back out of the (mocked) email body - the same way a real
 * recipient reads it out of their inbox. */
async function signInWithEmail(t: T, email: string) {
  sendMessage.mockClear(); // isolate this sign-in's send from any earlier one in the same test
  const started = await t.action(api.auth.signIn, {
    provider: "email",
    params: { email },
  });
  expect(started).toEqual({ started: true });
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const [, inboxId, message] = sendMessage.mock.calls[0]!;
  expect(inboxId).toBe("inbox_test");
  expect(message.to).toBe(email);
  const code = /code is (\S+)\./.exec(message.text ?? "")?.[1];
  expect(code).toBeTruthy();
  const signedIn = await t.action(api.auth.signIn, {
    provider: "email",
    params: { email, code },
  });
  expect(signedIn.tokens).toBeTruthy();
  const userId = await t.run(async (ctx) => {
    const account = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    return account!._id;
  });
  return { userId, identity: t.withIdentity({ subject: `${userId}|session` }) };
}

describe("email sign-in journey", () => {
  it("verifies an email through the stock Email OTP provider without a second mail path", async () => {
    const t = setup();
    const { userId } = await signInWithEmail(t, "reader@example.com");
    const account = await t.run((ctx) => ctx.db.get(userId));
    expect(account).toMatchObject({
      email: "reader@example.com",
      emailVerificationTime: expect.any(Number),
    });
    // AgentMail's mutation-only enqueue was called; nothing beyond it (no
    // `status`/network calls) - the send is durably queued, not delivered
    // synchronously, and this test never advances the scheduler to run it.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("reports identity through auth.me before and after verification", async () => {
    const t = setup();
    expect(await t.query(api.auth.me, {})).toBeNull();
    const { identity } = await signInWithEmail(t, "me@example.com");
    expect(await identity.query(api.auth.me, {})).toEqual({
      isAnonymous: false,
      email: "me@example.com",
      emailVerified: true,
    });
  });

  it("rejects a wrong code without signing anyone in", async () => {
    const t = setup();
    await t.action(api.auth.signIn, { provider: "email", params: { email: "wrong@example.com" } });
    await expect(
      t.action(api.auth.signIn, {
        provider: "email",
        params: { email: "wrong@example.com", code: "not-the-code" },
      }),
    ).rejects.toThrow("Could not verify code");
  });
});

describe("digest preview and explicit send", () => {
  it("previews the digest without sending anything, then sends the identical content", async () => {
    const t = setup();
    const { identity, userId } = await signInWithEmail(t, "digest@example.com");
    sendMessage.mockClear(); // isolate the sign-in send from the digest send asserted below
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: userId,
        raw: "@theo convex",
        sort: "relevance",
        status: "complete",
        rows: [
          {
            tweetId: "1",
            author: "theo",
            text: "hello from convex",
            url: "https://x.com/theo/status/1",
            links: [],
          },
        ],
        warnings: [],
      }),
    );
    const preview = await identity.query(api.email.preview, { sessionId });
    expect(preview.verifiedEmail).toBe("digest@example.com");
    expect(preview.rowCount).toBe(1);
    expect(preview.totalCount).toBe(1);
    expect(preview.text).toContain("@theo");
    expect(preview.text).toContain("hello from convex");
    expect(sendMessage).not.toHaveBeenCalled();

    await identity.mutation(api.email.send, {
      sessionId,
      recipient: "digest@example.com",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]![2];
    // preview and send must never drift: same buildDigest, one digest.
    expect(sent.subject).toBe(preview.subject);
    expect(sent.text).toBe(preview.text);
    const deliveries = await t.run((ctx) =>
      ctx.db.query("deliveries").withIndex("by_owner", (q) => q.eq("owner", userId)).collect(),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ outboundId: "outbound_test_id", query: "@theo convex" });
  });

  it("keeps send gated on a verified, matching email even after digest preview succeeds", async () => {
    const t = setup();
    const { identity, userId } = await signInWithEmail(t, "owner@example.com");
    sendMessage.mockClear();
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: userId,
        raw: "convex",
        sort: "relevance",
        status: "complete",
        rows: [{ tweetId: "1", author: "x", text: "hi", url: "https://x.com/x/status/1", links: [] }],
        warnings: [],
      }),
    );
    await expect(identity.query(api.email.preview, { sessionId })).resolves.toBeTruthy();
    await expect(
      identity.mutation(api.email.send, { sessionId, recipient: "someone-else@example.com" }),
    ).rejects.toThrow("verified email");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("fails closed for a non-owner on both preview and send", async () => {
    const t = setup();
    const { identity: owner, userId: ownerId } = await signInWithEmail(t, "owner2@example.com");
    const { identity: intruder } = await signInWithEmail(t, "intruder@example.com");
    sendMessage.mockClear();
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: ownerId,
        raw: "convex",
        sort: "relevance",
        status: "complete",
        rows: [{ tweetId: "1", author: "x", text: "hi", url: "https://x.com/x/status/1", links: [] }],
        warnings: [],
      }),
    );
    await expect(intruder.query(api.email.preview, { sessionId })).rejects.toThrow(
      "no completed search results to preview",
    );
    await expect(
      intruder.mutation(api.email.send, { sessionId, recipient: "intruder@example.com" }),
    ).rejects.toThrow(/verified email|no completed search results to send/);
    expect(sendMessage).not.toHaveBeenCalled();
    // The genuine owner can still see it - the rejection above was ownership,
    // not a broken fixture.
    await expect(owner.query(api.email.preview, { sessionId })).resolves.toBeTruthy();
  });

  it("blocks send by default with REQUIRE_VERIFIED_EMAIL entirely unset, not just when it is true", async () => {
    expect(process.env.REQUIRE_VERIFIED_EMAIL).toBeUndefined();
    const t = setup({ stubRequireVerifiedEmail: false });
    expect(process.env.REQUIRE_VERIFIED_EMAIL).toBeUndefined();
    const { identity, userId } = await signInWithEmail(t, "unset-flag@example.com");
    sendMessage.mockClear();
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: userId,
        raw: "convex",
        sort: "relevance",
        status: "complete",
        rows: [{ tweetId: "1", author: "x", text: "hi", url: "https://x.com/x/status/1", links: [] }],
        warnings: [],
      }),
    );
    // Even signed in and even with a verified email on the account, sending
    // to a *different, unverified* recipient must still fail closed with no
    // flag set at all - the default is secure, not "off until configured".
    await expect(
      identity.mutation(api.email.send, { sessionId, recipient: "someone-else@example.com" }),
    ).rejects.toThrow("verified email");
    expect(sendMessage).not.toHaveBeenCalled();
    // The matching, verified recipient still works with the flag unset -
    // this isn't gated behind REQUIRE_VERIFIED_EMAIL at all any more.
    await identity.mutation(api.email.send, { sessionId, recipient: "unset-flag@example.com" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("requires a session (any identity) before previewing or sending at all", async () => {
    const t = setup();
    const { userId } = await signInWithEmail(t, "solo@example.com");
    sendMessage.mockClear(); // isolate the sign-in send from the assertion below
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: userId,
        raw: "convex",
        sort: "relevance",
        status: "complete",
        rows: [{ tweetId: "1", author: "x", text: "hi", url: "https://x.com/x/status/1", links: [] }],
        warnings: [],
      }),
    );
    await expect(t.query(api.email.preview, { sessionId })).rejects.toThrow("Start a session");
    await expect(t.mutation(api.email.send, { sessionId, recipient: "solo@example.com" })).rejects.toThrow(
      "Start a session",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("an anonymous-only session can never pass the verified-email send gate", () => {
  // src/App.tsx's `ensureSession` (around line 306) calls `signIn("anonymous")`
  // to authenticate search/import actions - that identity alone reaches
  // `send({ sessionId, recipient })` if the person never completes email
  // sign-in. src/App.tsx also mounts src/auth/EmailSignIn.tsx (in the "Email
  // these results" modal, gating Send until a verified email exists, and in
  // the Connections panel) and src/auth/AccountBadge.tsx (Connections panel),
  // so a verified identity is reachable too - see EmailSignIn.tsx's own doc
  // comment. This test covers the anonymous branch specifically: it drives,
  // at the convex-test level, exactly the identity an anonymous-only visitor
  // has, and shows the unconditional gate in convex/email.ts's `send`
  // (hardened against the prior fail-open REQUIRE_VERIFIED_EMAIL default)
  // rejects it. That gate is not weakened here to make this pass: an
  // anonymous session must always fail to send, by design, regardless of
  // whether the person went through EmailSignIn first.
  it("rejects an anonymous session's send attempt even though EmailSignIn offers a verified path", async () => {
    const t = setup();
    const anon = await t.action(api.auth.signIn, { provider: "anonymous", params: {} });
    expect(anon.tokens).toBeTruthy();
    const userId = await t.run(async (ctx) => {
      const anonymousUsers = await ctx.db.query("users").collect();
      expect(anonymousUsers).toHaveLength(1);
      expect(anonymousUsers[0]!.isAnonymous).toBe(true);
      return anonymousUsers[0]!._id;
    });
    const identity = t.withIdentity({ subject: `${userId}|session` });
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        owner: userId,
        raw: "convex",
        sort: "relevance",
        status: "complete",
        rows: [{ tweetId: "1", author: "x", text: "hi", url: "https://x.com/x/status/1", links: [] }],
        warnings: [],
      }),
    );
    // Matches src/App.tsx's send-form call shape (sessionId + the verified
    // address) with an anonymous identity standing in for a visitor who has
    // not been through EmailSignIn - the case this describe block covers.
    await expect(
      identity.mutation(api.email.send, { sessionId, recipient: "reader@example.com" }),
    ).rejects.toThrow("verified email");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("component rendering (src/auth/*.tsx)", () => {
  // No jsdom or @testing-library/react dependency is installed in this repo
  // (checked: package.json has neither, and vitest.config.ts sets no
  // `test.environment`) and adding one would touch package.json, which is
  // outside this change's owned files - so these are static-markup render
  // checks (react-dom/server, same no-new-dependency technique
  // tests/library-ui.test.ts already uses for src/library/Library.tsx), not
  // interactive/clicked-through DOM tests. They prove the two components
  // render their documented states correctly in isolation; they do not
  // exercise src/App.tsx's own mounting of them (the modal/Connections-panel
  // wiring). No test in this repo renders src/App.tsx itself (only src/
  // main.tsx does, at runtime) - that wiring is unverified by an automated
  // test today.
  it("EmailSignIn renders the request-code step by default", () => {
    const markup = renderToStaticMarkup(createElement(EmailSignIn, {}));
    expect(markup).toContain("Email address");
    expect(markup).toContain("Send sign-in code");
    expect(markup).not.toContain("Sign-in code");
  });

  it("AccountBadge renders nothing while identity is loading or absent", () => {
    authUiResponses.set(getFunctionName(api.auth.me), undefined);
    expect(renderToStaticMarkup(createElement(AccountBadge, {}))).toBe("");
    authUiResponses.set(getFunctionName(api.auth.me), null);
    expect(renderToStaticMarkup(createElement(AccountBadge, {}))).toBe("");
  });

  it("AccountBadge shows guest state for an anonymous session and signed-in state for a verified one", () => {
    authUiResponses.set(getFunctionName(api.auth.me), {
      isAnonymous: true,
      email: null,
      emailVerified: false,
    });
    expect(renderToStaticMarkup(createElement(AccountBadge, {}))).toContain("Guest session");

    authUiResponses.set(getFunctionName(api.auth.me), {
      isAnonymous: false,
      email: "reader@example.com",
      emailVerified: true,
    });
    const markup = renderToStaticMarkup(createElement(AccountBadge, {}));
    expect(markup).toContain("Signed in as reader@example.com");
    expect(markup).toContain("Sign out");
  });
});
