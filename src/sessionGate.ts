/**
 * Decides, once per page, whether this visitor needs an anonymous session.
 *
 * `useConvexAuth()` reports `isAuthenticated: false` while `isLoading` is
 * true — the client is still verifying the tokens it already holds. The old
 * `ensureSession` only looked at `isAuthenticated`, so a click during that
 * window called `signIn("anonymous")`, and the Anonymous provider creates a
 * NEW user every time. That replaced the stored identity: every job, library
 * row and bookmark the previous identity owned vanished from the UI, and a
 * "Retry import" on a job listed under the old identity failed with
 * "Continuation does not belong to this indexing job". Production had 18
 * anonymous users for one operator.
 *
 * So: never sign in while the client is still loading. Wait for it to settle;
 * if it settles authenticated there is nothing to do, and only an
 * unauthenticated, settled client gets a fresh anonymous session.
 */
export interface AuthState {
  readonly isLoading: boolean;
  readonly isAuthenticated: boolean;
}

export interface SessionGate {
  /** Feed the latest `useConvexAuth()` values, from a commit-phase ref callback. */
  update(state: AuthState): void;
  /** Resolves once the server has confirmed a session for this client. */
  ensure(): Promise<void>;
}

export const SESSION_TIMEOUT_MESSAGE = "Session connection timed out. Try again.";

export function createSessionGate(signIn: () => Promise<unknown>, timeoutMs = 20_000): SessionGate {
  let state: AuthState = { isLoading: true, isAuthenticated: false };
  let watchers: (() => void)[] = [];
  let pending: Promise<void> | null = null;

  function until(ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        watchers = watchers.filter((watch) => watch !== check);
        reject(new Error(SESSION_TIMEOUT_MESSAGE));
      }, timeoutMs);

      const check = () => {
        if (!ready()) {
          watchers.push(check);

          return;
        }
        clearTimeout(timer);
        resolve();
      };

      watchers.push(check);
    });
  }

  return {
    update(next) {
      state = next;

      for (const watch of watchers.splice(0)) watch();
    },
    ensure() {
      if (state.isAuthenticated) return Promise.resolve();

      if (pending) return pending;
      pending = (async () => {
        await until(() => !state.isLoading);

        if (state.isAuthenticated) return;
        await signIn();
        // signIn stores tokens before the websocket confirms authentication.
        await until(() => state.isAuthenticated);
      })().finally(() => {
        pending = null;
      });

      return pending;
    },
  };
}
