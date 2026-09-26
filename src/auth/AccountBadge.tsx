import { Match, Switch } from "solid-js";
import { useConvex } from "../data/convex";
import { useSnapshot } from "../data/snapshot";
import { publicRefresh } from "../data/publicRefresh";
import { api } from "../../convex/_generated/api";

export type AccountBadgeProps = {
  /** Applied to the root element; the integrator owns the visual styling. */
  class?: string;
};

/**
 * Shows the caller's own identity (convex/auth.ts's `me` query - never a
 * client-supplied id, so there is no other account this could leak) and a
 * sign-out action. Renders nothing while `me` is loading or the visitor has
 * no session at all.
 *
 * Wired into the app in src/operator/Connections.tsx.
 */
export function AccountBadge(props: AccountBadgeProps) {
  // Read on opening and on the header's Refresh, not kept live: it sits in
  // the Connections panel, whose reads all follow src/data/publicRefresh.ts.
  const me = useSnapshot(api.auth.me, () => ({}), publicRefresh.version).data;
  const { actions } = useConvex();

  return (
    <Switch>
      <Match when={me() && (!me()!.emailVerified || !me()!.email)}>
        <p class={props.class}>
          {me()!.isAnonymous ? "Guest session" : "Sign-in not verified"}
          {me()!.email ? ` (${me()!.email})` : ""}
        </p>
      </Match>
      <Match when={me()}>
        <p class={props.class}>
          Signed in as {me()!.email}{" "}
          <button type="button" onClick={() => void actions.signOut()}>
            Sign out
          </button>
        </p>
      </Match>
    </Switch>
  );
}

export default AccountBadge;
