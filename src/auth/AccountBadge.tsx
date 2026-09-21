import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import * as stylex from "@stylexjs/stylex";
import { api } from "../../convex/_generated/api";

export type AccountBadgeProps = {
  /** StyleX styles applied to the root element; the integrator owns the visual styling. */
  xstyle?: stylex.StyleXStyles;
};

/**
 * Shows the caller's own identity (convex/auth.ts's `me` query - never a
 * client-supplied id, so there is no other account this could leak) and a
 * sign-out action. Renders nothing while `me` is loading or the visitor has
 * no session at all.
 *
 * Wired into the app in src/App.tsx's Connections panel - see
 * EmailSignIn.tsx's doc comment.
 */
export function AccountBadge({ xstyle }: AccountBadgeProps) {
  const me = useQuery(api.auth.me);
  const { signOut } = useAuthActions();
  if (me === undefined || me === null) return null;
  if (!me.emailVerified || !me.email) {
    return (
      <p {...stylex.props(xstyle)}>
        {me.isAnonymous ? "Guest session" : "Sign-in not verified"}
        {me.email ? ` (${me.email})` : ""}
      </p>
    );
  }
  return (
    <p {...stylex.props(xstyle)}>
      Signed in as {me.email}{" "}
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </p>
  );
}

export default AccountBadge;
