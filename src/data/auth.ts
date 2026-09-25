import { createSignal, onSettled } from "solid-js";
import { ConvexError, convexToJson, jsonToConvex, type Value } from "convex/values";
import type { AuthActions, AuthSource, SyncClient } from "./convex";

/**
 * `@convex-dev/auth`'s client (its `react/client.js` AuthProvider), ported to
 * signals so the app needs no React. Storage keys and their namespacing are
 * the library's own, so a browser that already holds a session from the
 * React build keeps the same identity — `sessionGate.ts` explains why a
 * visitor silently gaining a NEW anonymous user loses everything they own.
 */

const VERIFIER_KEY = "__convexAuthOAuthVerifier";

const JWT_KEY = "__convexAuthJWT";

const REFRESH_KEY = "__convexAuthRefreshToken";

const RETRY_BACKOFF_MS = [500, 2000];

type Tokens = { token: string; refreshToken?: string };

type SignInResult = {
  redirect?: string;
  verifier?: string;
  tokens?: { token: string; refreshToken: string } | null;
};

/** `auth:signIn`'s arguments: a provider's `params`, plus the provider and
 * the stored OAuth verifier when there are any. */
interface SignInArgs {
  [field: string]: Value;
  params: Record<string, Value>;
}

// What Convex's HTTP API answers when the function itself threw.
const STATUS_UDF_FAILED = 560;

/**
 * `auth:signIn` over Convex's HTTP API — the request `ConvexHttpClient.action`
 * makes, without pulling that client into the bundle for this one call.
 */
async function signInOverHttp(address: string, args: Record<string, Value>): Promise<SignInResult> {
  const response = await fetch(`${address}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "auth:signIn",
      format: "convex_encoded_json",
      args: [convexToJson(args)],
    }),
  });

  if (!response.ok && response.status !== STATUS_UDF_FAILED) throw new Error(await response.text());

  const body: { status: string; value?: unknown; errorMessage?: string; errorData?: unknown } =
    await response.json();

  if (body.status === "success") {
    // SAFETY: `auth:signIn`'s return, decoded exactly as ConvexHttpClient does.
    return jsonToConvex(body.value as Parameters<typeof jsonToConvex>[0]) as SignInResult;
  }

  if (body.status === "error") {
    if (body.errorData === undefined) throw new Error(body.errorMessage);
    const error = new ConvexError<Value>(body.errorMessage ?? "");
    // SAFETY: as above — Convex-encoded JSON from the same API.
    error.data = jsonToConvex(body.errorData as Parameters<typeof jsonToConvex>[0]);
    throw error;
  }

  throw new Error(`Invalid response: ${JSON.stringify(body)}`);
}

export interface AuthClientOptions {
  readonly address: string;
  readonly sync: Pick<SyncClient, "action">;
  readonly storage?: Storage;
}

export function createAuthClient({
  address,
  sync,
  storage = localStorage,
}: AuthClientOptions): AuthSource & AuthActions {
  const namespace = address.replace(/[^a-zA-Z0-9]/g, "");
  const key = (name: string) => `${name}_${namespace}`;
  const get = (name: string) => storage.getItem(key(name));
  const set = (name: string, value: string) => storage.setItem(key(name), value);
  const remove = (name: string) => storage.removeItem(key(name));

  let token: string | null = null;
  let refreshing = false;
  const [isLoading, setIsLoading] = createSignal(true);
  const [hasToken, setHasToken] = createSignal(false);
  // Bumped whenever a different identity's token arrives (a sign-in, or
  // another tab signing in or out) — not on a refresh, which the Convex
  // client asked for itself. `hasToken` alone can't show that: an anonymous
  // visitor who signs in by email has a token before and after.
  const [identity, setIdentity] = createSignal(0);

  function setToken(tokens: Tokens | null, store: boolean) {
    token = tokens?.token ?? null;

    if (store) {
      if (tokens) {
        set(JWT_KEY, tokens.token);

        if (tokens.refreshToken) set(REFRESH_KEY, tokens.refreshToken);
      } else {
        remove(JWT_KEY);
        remove(REFRESH_KEY);
      }
    }

    setHasToken(token !== null);
    setIsLoading(false);

    if (!refreshing) setIdentity((n) => n + 1);
  }

  // Refresh-token exchanges must not carry the (possibly expired) JWT, so
  // they go over plain HTTP rather than the authenticated websocket.
  async function unauthenticated(args: Record<string, Value>): Promise<SignInResult> {
    let lastError: unknown;

    for (let attempt = 0; ; attempt++) {
      try {
        return await signInOverHttp(address, args);
      } catch (error) {
        lastError = error;

        // fetch reports network failures as TypeError; anything else is the
        // server's answer and retrying cannot change it.
        if (!(error instanceof TypeError) || attempt >= RETRY_BACKOFF_MS.length) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
      }
    }
  }

  // `provider` is absent only for the `?code=` exchange below, which the
  // server matches to the provider that issued the code.
  async function signIn(provider: string | undefined, params: Record<string, Value> = {}) {
    const verifier = get(VERIFIER_KEY);
    remove(VERIFIER_KEY);

    const args: SignInArgs = { params };

    if (provider !== undefined) args.provider = provider;

    if (verifier) args.verifier = verifier;
    const result: SignInResult = await sync.action("auth:signIn", args);

    if (result.redirect !== undefined) {
      if (result.verifier) set(VERIFIER_KEY, result.verifier);
      window.location.href = result.redirect;

      return { signingIn: false };
    }

    if (result.tokens !== undefined) {
      setToken(result.tokens, true);

      return { signingIn: result.tokens !== null };
    }

    return { signingIn: false };
  }

  async function signOut() {
    try {
      await sync.action("auth:signOut", {});
    } catch {
      // Usually "already signed out", which is the state we want anyway.
    }

    setToken(null, true);
  }

  async function refresh(): Promise<string | null> {
    const before = token;

    return exclusive(key(REFRESH_KEY), async () => {
      // Another tab refreshed while this one waited for the lock.
      if (token !== before) return token;
      const refreshToken = get(REFRESH_KEY);

      if (!refreshToken) return null;
      refreshing = true;

      try {
        const { tokens } = await unauthenticated({ refreshToken });
        setToken(tokens ?? null, true);
      } finally {
        refreshing = false;
      }

      return token;
    });
  }

  const fetchAccessToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }) =>
    forceRefreshToken ? refresh() : token;

  const restoreStored = () => {
    const stored = get(JWT_KEY);
    setToken(stored === null ? null : { token: stored }, false);
  };

  onSettled(() => {
    const code = new URLSearchParams(window.location.search).get("code");

    if (code) {
      const url = new URL(window.location.href);
      url.searchParams.delete("code");
      window.history.replaceState(window.history.state, "", url);
      // An expired or already-used code (or a redirect, or no tokens) must
      // not leave the app loading forever: carry on with whatever session
      // this browser already had.
      void signIn(undefined, { code }).then(
        ({ signingIn }) => {
          if (!signingIn && isLoading()) restoreStored();
        },
        () => restoreStored(),
      );
    } else {
      restoreStored();
    }

    // Another tab signed in or out: follow it, without writing back (the
    // write is what fired this event). Another tab refreshing the same
    // identity's token is not an identity change: take the new token
    // without bumping `identity`, as this tab's own refresh does.
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== storage || event.key !== key(JWT_KEY)) return;

      if (event.newValue !== null && token !== null && sameSubject(token, event.newValue)) {
        token = event.newValue;

        return;
      }

      setToken(event.newValue === null ? null : { token: event.newValue }, false);
    };

    // Leaving mid-refresh can strand the refresh token; ask first.
    const onUnload = (event: BeforeUnloadEvent) => {
      if (refreshing) event.preventDefault();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("beforeunload", onUnload);
    };
  });

  return { isLoading, isAuthenticated: hasToken, identity, fetchAccessToken, signIn, signOut };
}

/** The JWT's `sub` claim, or null when it can't be read. */
function subjectOf(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];

    if (!payload) return null;

    const claims: { sub?: string } = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );

    return claims.sub ?? null;
  } catch {
    return null;
  }
}

/** Both tokens name the same, readable subject. */
function sameSubject(a: string, b: string): boolean {
  const subject = subjectOf(a);

  return subject !== null && subject === subjectOf(b);
}

/** Run `fn` as the only tab doing so (the Web Locks API, where available). */
async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;

  return locks ? await locks.request(name, fn) : await fn();
}
