import { useId, useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { describeError } from "../errors";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailSignInProps = {
  /** Applied to the root element; the integrator owns the visual styling. */
  className?: string;
  /** Called once `signIn("email", { email, code })` resolves. */
  onSignedIn?: () => void;
};

/**
 * Two-step, durable email sign-in on top of @convex-dev/auth's stock Email
 * provider (convex/auth.ts): request a one-time code, then verify it. Codes
 * are delivered through AgentMail (see convex/auth.ts's
 * sendVerificationRequest) - this component only drives the two `signIn`
 * calls and never talks to AgentMail directly.
 *
 * Unstyled by design: mount it wherever a "sign in with email" affordance is
 * needed (e.g. the Connections panel or a settings page) and style the
 * className/child elements to match.
 *
 * Not wired into the app yet: nothing under src/ outside this directory
 * imports EmailSignIn or AccountBadge today, so guest-only anonymous
 * sign-in (src/App.tsx's ensureSession) is still the only reachable path
 * for a user of the running app. That wiring - plus threading
 * api.email.preview into the existing send modal - touches src/App.tsx
 * (or src/Dashboard.tsx), which is outside this change's owned files;
 * it's tracked as separate follow-up work, not implied to be done here.
 */
export function EmailSignIn({ className, onSignedIn }: EmailSignInProps) {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<"request" | "verify">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const emailFieldId = useId();
  const codeFieldId = useId();

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await signIn("email", { email: trimmed });
      setEmail(trimmed);
      setCode("");
      setStep("verify");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  };

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setError("Enter the code from your email.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await signIn("email", { email, code: trimmedCode });
      setCode("");
      onSignedIn?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  };

  const useDifferentEmail = () => {
    setStep("request");
    setCode("");
    setError("");
  };

  return (
    <div className={className}>
      {step === "request" ? (
        <form onSubmit={requestCode}>
          <label htmlFor={emailFieldId}>Email address</label>
          <input
            id={emailFieldId}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={pending}
            required
          />
          <button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send sign-in code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode}>
          <p role="status">Enter the code sent to {email}.</p>
          <label htmlFor={codeFieldId}>Sign-in code</label>
          <input
            id={codeFieldId}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Code from email"
            disabled={pending}
            required
          />
          <button type="submit" disabled={pending}>
            {pending ? "Verifying…" : "Verify and sign in"}
          </button>
          <button type="button" onClick={useDifferentEmail} disabled={pending}>
            Use a different email
          </button>
        </form>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

export default EmailSignIn;
