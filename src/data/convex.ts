import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onSettled,
  untrack,
  useContext,
  type Accessor,
} from "solid-js";
import {
  getFunctionName,
  type DefaultFunctionArgs,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { convexToJson, type Value } from "convex/values";
import type {
  AuthTokenFetcher,
  BaseConvexClient,
  ConnectionState,
  QueryToken,
} from "convex/browser";

/**
 * The slice of Convex's `BaseConvexClient` these bindings use. The real
 * client satisfies it; tests hand in a fake keyed by function name.
 *
 * `BaseConvexClient` rather than `ConvexClient`: the latter wraps it with a
 * paginated-query client this app never uses, which would only add bytes.
 */
export type SyncClient = Pick<
  BaseConvexClient,
  | "subscribe"
  | "localQueryResult"
  | "addOnTransitionHandler"
  | "mutation"
  | "action"
  | "setAuth"
  | "clearAuth"
  | "connectionState"
  | "subscribeToConnectionState"
>;

/** What an auth provider tells Convex (see src/data/auth.ts). */
export interface AuthSource {
  readonly isLoading: Accessor<boolean>;
  readonly isAuthenticated: Accessor<boolean>;
  /** Changes when a different identity's token arrives, so Convex is told
   * again even though `isAuthenticated` stayed true. */
  readonly identity?: Accessor<number>;
  readonly fetchAccessToken: AuthTokenFetcher;
}

export interface AuthActions {
  signIn(provider: string, params?: Record<string, Value>): Promise<{ signingIn: boolean }>;
  signOut(): Promise<void>;
}

export interface ConvexApp {
  readonly sync: SyncClient;
  /** Call `fn` whenever Convex reports a new result for `token`. */
  listen(token: QueryToken, fn: () => void): () => void;
  readonly connection: Accessor<ConnectionState>;
  /** Auth as Convex sees it: authenticated only once the backend has confirmed the token. */
  readonly isLoading: Accessor<boolean>;
  readonly isAuthenticated: Accessor<boolean>;
  readonly actions: AuthActions;
}

export const ConvexContext = createContext<ConvexApp>();

/**
 * Wire a sync client to an auth source. The auth half is a port of
 * `convex/react`'s `ConvexProviderWithAuth`: `isLoading` stays true until the
 * backend has confirmed (or refused) the token the provider holds, so a
 * caller never mistakes "still verifying" for "signed out".
 */
export function createConvexApp(sync: SyncClient, source: AuthSource, actions: AuthActions) {
  const listeners = new Map<QueryToken, Set<() => void>>();

  sync.addOnTransitionHandler((transition) => {
    for (const { token } of transition.queries) for (const fn of listeners.get(token) ?? []) fn();
  });

  const listen = (token: QueryToken, fn: () => void) => {
    const set = listeners.get(token) ?? new Set();
    set.add(fn);
    listeners.set(token, set);

    return () => {
      set.delete(fn);

      if (!set.size) listeners.delete(token);
    };
  };

  const [connection, setConnection] = createSignal(sync.connectionState());

  onSettled(() => sync.subscribeToConnectionState((state) => setConnection(() => state)));

  const [confirmed, setConfirmed] = createSignal<boolean | null>(null);

  createEffect(
    () => ({
      loading: source.isLoading(),
      authed: source.isAuthenticated(),
      identity: source.identity?.(),
    }),
    ({ loading, authed }) => {
      if (loading) {
        setConfirmed(null);

        return;
      }

      if (!authed) {
        setConfirmed(false);

        return;
      }

      let relevant = true;

      sync.setAuth(source.fetchAccessToken, (backendAuthed) => {
        if (relevant) setConfirmed(backendAuthed);
      });

      return () => {
        relevant = false;
        sync.clearAuth();
        setConfirmed(null);
      };
    },
  );

  const app: ConvexApp = {
    sync,
    listen,
    connection,
    isLoading: () => confirmed() === null,
    isAuthenticated: () => source.isAuthenticated() && confirmed() === true,
    actions,
  };

  return app;
}

export function useConvex(): ConvexApp {
  return useContext(ConvexContext);
}

// SAFETY: a Convex function's declared args are, by the validator that
// generated `FunctionArgs`, a plain object of Convex values — what the wire
// client takes. The generic type just can't show TypeScript that.
const wire = (args: DefaultFunctionArgs) => args as Record<string, Value>;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

const EMPTY: Result<undefined> = { ok: true, value: undefined };

/**
 * A live Convex query. `args` returning "skip" unsubscribes and reads
 * `undefined`, the same contract as `convex/react`'s `useQuery`. The
 * subscription is keyed by the serialized arguments, so a new args object
 * with the same content never resubscribes. A query error is rethrown on
 * read, so it reaches the nearest `<Errored>` boundary — unless `soft`, for
 * decoration that must never take the page down with it (it then reads
 * `undefined`, like a query that hasn't answered).
 *
 * `stable` keeps the last result while changed arguments have none yet, so a
 * query fed a ticking `now` never flips its readers back to "loading"
 * (src/library/stableQuery.ts). A skip still clears it.
 */
export function useQuery<Q extends FunctionReference<"query">>(
  ref: Q,
  args: () => FunctionArgs<Q> | "skip",
  options: { soft?: boolean; stable?: boolean } = {},
): Accessor<FunctionReturnType<Q> | undefined> {
  const convex = useConvex();
  const name = getFunctionName(ref);
  const [result, setResult] = createSignal<Result<FunctionReturnType<Q> | undefined>>(EMPTY);

  const key = createMemo(() => {
    const value = args();

    return value === "skip" ? null : JSON.stringify(convexToJson(wire(value)));
  });

  createEffect(key, (serialized) => {
    if (serialized === null) {
      setResult(EMPTY);

      return;
    }

    const value = untrack(args);

    if (value === "skip") return;
    const { queryToken, unsubscribe } = convex.sync.subscribe(name, wire(value));

    const read = () => {
      try {
        const next = convex.sync.localQueryResult(name, wire(value));

        if (next === undefined && options.stable && untrack(result).ok) return;
        setResult({ ok: true, value: next });
      } catch (error) {
        setResult({ ok: false, error });
      }
    };

    // Already cached (another subscriber, or a revisited query): show it now.
    read();

    const stop = convex.listen(queryToken, read);

    return () => {
      stop();
      unsubscribe();
    };
  });

  return () => {
    const current = result();

    if (current.ok) return current.value;

    if (options.soft) return undefined;
    throw current.error;
  };
}

export function useMutation<M extends FunctionReference<"mutation">>(ref: M) {
  const convex = useConvex();
  const name = getFunctionName(ref);

  // SAFETY: the server validates this mutation's return against the same
  // `returns` validator that `FunctionReturnType` is derived from.
  return (args: FunctionArgs<M>): Promise<FunctionReturnType<M>> =>
    convex.sync.mutation(name, wire(args)) as Promise<FunctionReturnType<M>>;
}

export function useAction<A extends FunctionReference<"action">>(ref: A) {
  const convex = useConvex();
  const name = getFunctionName(ref);

  // SAFETY: as for `useMutation`: the action's `returns` validator is what
  // `FunctionReturnType` is derived from.
  return (args: FunctionArgs<A>): Promise<FunctionReturnType<A>> =>
    convex.sync.action(name, wire(args)) as Promise<FunctionReturnType<A>>;
}
