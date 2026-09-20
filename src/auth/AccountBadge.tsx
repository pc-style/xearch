import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export type AccountBadgeProps = {
  /** Applied to the root element; the integrator owns the visual styling. */
  className?: string;
};

/**
 * Shows the caller's own identity (convex/auth.ts's `me` query - never a
 * client-supplied id, so there is no other account this could leak) and a
 * sign-out action. Renders nothing while `me` is loading or the visitor has
 * no session at all.
 *
 * Not wired into the app yet - see EmailSignIn.tsx's doc comment.
 */
export function AccountBadge({ className }: AccountBadgeProps) {
  const me = useQuery(api.auth.me);
  const { signOut } = useAuthActions();
  if (me === undefined || me === null) return null;
  if (!me.emailVerified || !me.email) {
    return (
      <p className={className}>
        {me.isAnonymous ? "Guest session" : "Sign-in not verified"}
        {me.email ? ` (${me.email})` : ""}
      </p>
    );
  }
  return (
    <p className={className}>
      Signed in as {me.email}{" "}
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </p>
  );
}

export default AccountBadge;
