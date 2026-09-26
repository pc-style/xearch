import { describe, expect, it } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { EmailSignIn } from "../src/auth/EmailSignIn";
import { AccountBadge } from "../src/auth/AccountBadge";
import { fakeConvex, mount, renderHtml, settle, stripMarkers } from "./solid";

// src/auth/*.tsx rendered in isolation under the fake Convex app
// (tests/solid.ts): `me` answers from a fixture, and sign-in/out go to the
// fake's recording `actions`. The server side of the same flows — the OTP
// exchange, the verified-email gate on `email.send` — is covered end to end
// in tests/journey.test.ts.
const me = (value: FunctionReturnType<typeof api.auth.me> | undefined) =>
  fakeConvex({ results: value === undefined ? [] : [[api.auth.me, value]] });

// SAFETY: `Id<"users">` is a branded string; this fixture only needs a
// stable test-authored id, which no code path here resolves.
const userId = "user-1" as Id<"users">;

describe("EmailSignIn (src/auth/EmailSignIn.tsx)", () => {
  it("renders the request-code step by default", () => {
    const markup = renderHtml(EmailSignIn, {}, fakeConvex());
    expect(markup).toContain("Email address");
    expect(markup).toContain("Send sign-in code");
    expect(markup).not.toContain("Sign-in code");
  });

  it("asks for the code once one has been sent, and signs in with both", async () => {
    const calls: unknown[] = [];
    const convex = fakeConvex();

    convex.actions.signIn = (provider, params) => {
      calls.push([provider, params]);

      return Promise.resolve({ signingIn: true });
    };

    let signedIn = 0;
    const mounted = mount(EmailSignIn, { onSignedIn: () => void signedIn++ }, convex);
    const email = mounted.container.querySelector<HTMLInputElement>('input[type="email"]')!;
    email.value = "Reader@Example.com";
    email.dispatchEvent(new InputEvent("input", { bubbles: true }));
    // Solid applies the write on its next flush, which a browser reaches
    // between two user events; here they are back to back.
    await settle();
    mounted.container.querySelector("form")!.requestSubmit();
    await settle();

    expect(stripMarkers(mounted.html())).toContain("Enter the code sent to reader@example.com.");

    const code = mounted.container.querySelector<HTMLInputElement>(
      'input[autocomplete="one-time-code"]',
    )!;

    code.value = " 123456 ";
    code.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    mounted.container.querySelector("form")!.requestSubmit();
    await settle();

    expect(calls).toEqual([
      ["email", { email: "reader@example.com" }],
      ["email", { email: "reader@example.com", code: "123456" }],
    ]);
    expect(signedIn).toBe(1);
    mounted.unmount();
  });

  it("refuses a malformed address before asking the server", async () => {
    const convex = fakeConvex();
    let asked = false;

    convex.actions.signIn = () => {
      asked = true;

      return Promise.resolve({ signingIn: false });
    };

    const mounted = mount(EmailSignIn, {}, convex);
    const email = mounted.container.querySelector<HTMLInputElement>('input[type="email"]')!;
    email.value = "not-an-email";
    email.dispatchEvent(new InputEvent("input", { bubbles: true }));
    mounted.container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();

    expect(mounted.html()).toContain("Enter a valid email address.");
    expect(asked).toBe(false);
    mounted.unmount();
  });
});

describe("AccountBadge (src/auth/AccountBadge.tsx)", () => {
  it("renders nothing while identity is loading or absent", () => {
    expect(renderHtml(AccountBadge, {}, me(undefined))).toBe("");
    expect(renderHtml(AccountBadge, {}, me(null))).toBe("");
  });

  // The badge reads identity once (src/data/snapshot.ts), so the markup
  // arrives after a settle rather than on the first render.
  const badge = async (value: FunctionReturnType<typeof api.auth.me>) => {
    const mounted = mount(AccountBadge, {}, me(value));
    await settle();
    const markup = stripMarkers(mounted.html());
    mounted.unmount();

    return markup;
  };

  it("shows guest state for an anonymous session and signed-in state for a verified one", async () => {
    expect(
      await badge({ id: userId, isAnonymous: true, email: null, emailVerified: false }),
    ).toContain("Guest session");

    const markup = await badge({
      id: userId,
      isAnonymous: false,
      email: "reader@example.com",
      emailVerified: true,
    });

    expect(markup).toContain("Signed in as reader@example.com");
    expect(markup).toContain("Sign out");
  });
});
